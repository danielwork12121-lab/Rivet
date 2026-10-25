// Rivet chat assistant — real Claude call, server-side only.
// The frontend (pages/find-solution.html) POSTs { message, mode } here so the
// Anthropic API key never reaches the browser. Runs as a Vercel serverless
// function (Node.js runtime, auto-detected from this file's path under /api).
// Only signed-in Client accounts may use it: the request must carry the
// visitor's Clerk session token (Authorization: Bearer ...), which this function
// forwards to Convex. Convex verifies it and checks the account's role before
// any budget is reserved, so this file never parses or trusts the token itself.
//
// Off unless fully configured. Vercel env vars:
//   CHAT_ENABLED=true        explicit switch; anything else keeps chat off
//   ANTHROPIC_API_KEY        the Anthropic key (Vercel only, never the browser)
//   CONVEX_URL               e.g. https://coordinated-canary-9.convex.cloud
//   RIVET_SERVER_SECRET      shared with the Convex deployment's env vars
// Before every paid call this function reserves budget in Convex
// (aiBudget:reserveChat), which enforces a global daily cap shared with the rest
// of Rivet's AI, a per-account cap, and a per-visitor cap keyed by a hash of
// the visitor's IP.
// Every failure returns an explicit { error, message }; never a made-up reply.

import { createHmac } from "node:crypto";

// The fast model: this route writes one short sentence, so speed matters more
// than depth. convex/ai.ts uses the same model (FAST_MODEL) for its quick steps.
const MODEL = "claude-haiku-5-5";
// Vercel's default function timeout (10s on Hobby) was shorter than our old
// 12s AbortController, so Vercel could kill the function before our own
// timeout/error-handling ever ran, leaving the frontend with a bare failed
// fetch and no clean error — that's the intermittent "Rivet AI is unavailable"
// behavior. vercel.json now sets maxDuration: 30 for this function; keep this
// value comfortably under that so we always get to return our own JSON error.
const TIMEOUT_MS = 25000;
// Haiku thinks briefly before answering, so leave room beyond the ~20-word reply.
const MAX_TOKENS = 2000;

const SYSTEM_PROMPTS = {
  // First message: the operator just described a job. The app's own form asks
  // the structured follow-up questions right after this, so just react to
  // what they wrote — don't ask questions or list options yourself.
  opening: `You are the Rivet assistant, part of a robotics-bounty marketplace
for infrastructure, facilities, lawn-care and pest-control operators. The
operator just described a job they want a robot to take on. Reply with ONE
short sentence (max ~20 words) that shows you understood the specific job
they described, and say their matches are shown on the left. Do not ask
questions, do not list options, do not use markdown or emoji.`,
  // After the structured Q&A chips are done, they can keep typing freeform.
  followup: `You are the Rivet assistant, part of a robotics-bounty
marketplace for infrastructure, facilities, lawn-care and pest-control
operators. The operator already answered the app's structured intake
questions (location, team size, hours, labor cost, safety, budget). They just
sent another freeform message. Reply briefly and specifically (max ~2 short
sentences), acknowledging what they said. No markdown, no emoji, no
re-asking the questions above.`,
  // Drives the "Top matches" header label — not shown as a chat bubble.
  // Input is everything the operator has typed so far, joined into one
  // string. Needs to stay current as the conversation adds detail, so this
  // is re-run after every message, not just the first.
  topic: `You are extracting a short topic label from an operator's messages
to Rivet, a robotics-bounty marketplace. You'll get everything they've said
about the job so far, in order. Reply with 3 to 6 words summarizing the job
and the single most defining detail (e.g. "commercial lawn mowing",
"warehouse floor cleaning, 50k sqft site"). Lowercase unless a proper noun.
No ending punctuation, no quotes, no markdown. If there isn't enough
information yet, give your best short guess rather than refusing or asking
a question.`,
};

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const UNAVAILABLE = "The AI assistant isn't available right now.";
const SIGN_IN = "Sign in with a Client account to use the AI assistant.";
// A JWT: three base64url parts. Anything else is refused before calling Convex.
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

// Stable per-visitor key without storing the IP: HMAC with the server secret.
function visitorKey(req, secret) {
  const h = req.headers || {};
  const ip = String(h["x-vercel-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-for"] || "unknown")
    .split(",")[0].trim();
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

// Ask Convex for one unit of budget, as the signed-in visitor. Any problem means
// "no": fail closed. A token Convex rejects (expired, forged, wrong audience)
// comes back as an auth error, reported as "unauthenticated".
async function reserveBudget(convexUrl, secret, clientKey, userToken) {
  try {
    const r = await fetch(`${convexUrl.replace(/\/+$/, "")}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ path: "aiBudget:reserveChat", args: { secret, clientKey }, format: "json" }),
    });
    const data = await r.json().catch(() => null);
    if (data?.status === "success" && data.value?.ok === true) return { ok: true };
    if (data?.status === "success") return { ok: false, reason: data.value?.reason ?? "unavailable" };
    if (r.status === 401 || /Unauthenticated|InvalidAuthHeader|NoAuthProvider|token/i.test(String(data?.errorMessage ?? data?.code ?? ""))) {
      return { ok: false, reason: "unauthenticated" };
    }
    return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const { CHAT_ENABLED, ANTHROPIC_API_KEY, CONVEX_URL, RIVET_SERVER_SECRET } = process.env;
  if (CHAT_ENABLED !== "true" || !ANTHROPIC_API_KEY || !CONVEX_URL || !RIVET_SERVER_SECRET) {
    return fail(res, 503, "unavailable", UNAVAILABLE);
  }
  const bearer = String(req.headers?.authorization || "").match(BEARER);
  if (!bearer) return fail(res, 401, "unauthenticated", SIGN_IN);

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return fail(res, 400, "bad_request", "Invalid JSON body.");
    }
  }
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  const mode = ["followup", "topic"].includes(body?.mode) ? body.mode : "opening";
  if (!message) return fail(res, 400, "bad_request", "message is required.");

  const budget = await reserveBudget(CONVEX_URL, RIVET_SERVER_SECRET, visitorKey(req, RIVET_SERVER_SECRET), bearer[1]);
  if (!budget.ok) {
    if (budget.reason === "unauthenticated") return fail(res, 401, "unauthenticated", SIGN_IN);
    if (budget.reason === "not_client") return fail(res, 403, "forbidden", "The AI assistant is for Client accounts.");
    if (budget.reason === "no_account") return fail(res, 403, "no_account", "Finish setting up your Rivet account to use the AI assistant.");
    return budget.reason === "unavailable"
      ? fail(res, 503, "unavailable", UNAVAILABLE)
      : fail(res, 429, "limit", "The AI assistant has reached its limit for today.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: "low" }, // short replies; keeps thinking (and cost) small
        system: SYSTEM_PROMPTS[mode],
        messages: [{ role: "user", content: message }],
      }),
      signal: controller.signal,
    });
    // Never pass Anthropic's error text to the browser.
    if (!r.ok) return fail(res, 502, "failed", "The AI assistant couldn't answer just now.");

    const data = await r.json();
    const reply = Array.isArray(data?.content)
      ? data.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()
      : "";
    if (data?.stop_reason === "refusal" || data?.stop_reason === "max_tokens" || !reply) {
      return fail(res, 502, "failed", "The AI assistant couldn't answer just now.");
    }
    return res.status(200).json({ reply });
  } catch (err) {
    return err?.name === "AbortError"
      ? fail(res, 504, "timeout", "The AI assistant took too long to answer.")
      : fail(res, 502, "failed", "The AI assistant couldn't answer just now.");
  } finally {
    clearTimeout(timeout);
  }
}

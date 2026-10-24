// Rivet chat assistant — real Claude call, server-side only.
// The frontend (pages/find-solution.html) POSTs { message, mode } here so the
// Anthropic API key never reaches the browser. Runs as a Vercel serverless
// function (Node.js runtime, auto-detected from this file's path under /api).
//
// Off unless fully configured. Vercel env vars:
//   CHAT_ENABLED=true        explicit switch; anything else keeps chat off
//   ANTHROPIC_API_KEY        the Anthropic key (Vercel only, never the browser)
//   CONVEX_URL               e.g. https://coordinated-canary-9.convex.cloud
//   RIVET_SERVER_SECRET      shared with the Convex deployment's env vars
// Before every paid call this function reserves budget in Convex
// (aiBudget:reserveChat), which enforces a global daily cap shared with the rest
// of Rivet's AI and a per-visitor cap keyed by a hash of the visitor's IP.
// Every failure returns an explicit { error, message }; never a made-up reply.

import { createHmac } from "node:crypto";

const MODEL = "claude-opus-5-5"; // matches convex/ai.ts
// Vercel's default function timeout (10s on Hobby) was shorter than our old
// 12s AbortController, so Vercel could kill the function before our own
// timeout/error-handling ever ran, leaving the frontend with a bare failed
// fetch and no clean error — that's the intermittent "Rivet AI is unavailable"
// behavior. vercel.json now sets maxDuration: 30 for this function; keep this
// value comfortably under that so we always get to return our own JSON error.
const TIMEOUT_MS = 25000;
const MAX_TOKENS = 1024; // thinking counts toward this on claude-opus-5-5; 150 often left no room for text

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
};

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const UNAVAILABLE = "The AI assistant isn't available right now.";

// Stable per-visitor key without storing the IP: HMAC with the server secret.
function visitorKey(req, secret) {
  const h = req.headers || {};
  const ip = String(h["x-vercel-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-for"] || "unknown")
    .split(",")[0].trim();
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

// Ask Convex for one unit of budget. Any problem means "no": fail closed.
async function reserveBudget(convexUrl, secret, clientKey) {
  try {
    const r = await fetch(`${convexUrl.replace(/\/+$/, "")}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "aiBudget:reserveChat", args: { secret, clientKey }, format: "json" }),
    });
    const data = await r.json();
    if (data?.status === "success" && data.value?.ok === true) return { ok: true };
    return { ok: false, reason: data?.value?.reason ?? "unavailable" };
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

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return fail(res, 400, "bad_request", "Invalid JSON body.");
    }
  }
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  const mode = body?.mode === "followup" ? "followup" : "opening";
  if (!message) return fail(res, 400, "bad_request", "message is required.");

  const budget = await reserveBudget(CONVEX_URL, RIVET_SERVER_SECRET, visitorKey(req, RIVET_SERVER_SECRET));
  if (!budget.ok) {
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

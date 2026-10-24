// Rivet chat assistant — real Claude call, server-side only.
// The frontend (pages/find-solution.html) POSTs { message, mode } here so the
// Anthropic API key never reaches the browser. Runs as a Vercel serverless
// function (Node.js runtime, auto-detected from this file's path under /api).
//
// Env var required: ANTHROPIC_API_KEY (set in Vercel → Project Settings →
// Environment Variables). Until it's set, this returns 500 and the frontend
// falls back to its built-in static copy — the page still works either way.

const MODEL = "claude-opus-5-5"; // matches convex/ai.ts
// Vercel's default function timeout (10s on Hobby) was shorter than our old
// 12s AbortController, so Vercel could kill the function before our own
// timeout/error-handling ever ran, leaving the frontend with a bare failed
// fetch and no clean error — that's the intermittent "Rivet AI is unavailable"
// behavior. vercel.json now sets maxDuration: 30 for this function; keep this
// value comfortably under that so we always get to return our own JSON error.
const TIMEOUT_MS = 25000;

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
  const mode = body?.mode === "followup" ? "followup" : "opening";
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        system: SYSTEM_PROMPTS[mode],
        messages: [{ role: "user", content: message }],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(502).json({ error: "Anthropic API error", detail: errText.slice(0, 300) });
    }

    const data = await r.json();
    const reply = Array.isArray(data?.content)
      ? data.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()
      : "";

    if (!reply) {
      return res.status(502).json({ error: "Empty response from model" });
    }

    return res.status(200).json({ reply });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return res.status(timedOut ? 504 : 500).json({ error: timedOut ? "Request timed out" : "Request failed" });
  } finally {
    clearTimeout(timeout);
  }
}

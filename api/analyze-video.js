// Rivet video-analysis — Gemini multimodal call, server-side only.
// The frontend (pages/find-solution.html, Video Input tab) extracts a
// handful of sampled frames from an uploaded video in-browser (canvas, no
// server-side video processing) and POSTs their JPEG data URLs here. We hand
// them to Gemini as a small image set, ask for a structured task spec plus
// per-frame bounding boxes, and return normalized JSON. The frontend then
// feeds the task spec into the SAME matching pipeline the chat/manual-entry
// flows already use (fJob + formOn) — this file does not do any matching
// itself.
//
// Off unless fully configured. Vercel env vars:
//   VIDEO_ENABLED=true       explicit switch; anything else keeps analysis off
//   GEMINI_API_KEY           the Gemini key (Vercel only, never the browser)
//   CONVEX_URL               e.g. https://<deployment>.convex.cloud
//   RIVET_SERVER_SECRET      shared with the Convex deployment's env vars
// Only signed-in Client accounts may use it: the request must carry the visitor's
// Clerk session token (Authorization: Bearer ...). Before any Gemini request this
// function reserves budget in Convex (aiBudget:reserveVideo), which verifies the token,
// requires a Client account, and enforces per-account and global daily limits
// (VIDEO_USER_DAILY_LIMIT, VIDEO_DAILY_LIMIT) in one atomic mutation. Frames are size-
// and format-checked first, so malformed requests never spend budget. Errors never
// include Gemini's responses. The Video Input tab shows its "analysis unavailable"
// error for any non-200; upload/preview still works either way.

import { createHmac } from "node:crypto";

const MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 25000; // keep under vercel.json's maxDuration: 30 for this function
const MAX_FRAMES = 8;
// The page sends ~5 JPEG frames at 640px wide (tens of KB each). Generous caps, well
// under Vercel's request body limit.
const MAX_FRAME_CHARS = 600_000; // base64 characters per frame (~450 KB)
const MAX_TOTAL_CHARS = 2_500_000; // all frames together (~1.9 MB)
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SIGN_IN = "Sign in with a Client account to analyze a video.";
const UNAVAILABLE = "Video analysis isn't available right now.";
// A JWT: three base64url parts. Anything else is refused before calling Convex.
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    taskSummary: { type: "string" },
    environment: { type: "array", items: { type: "string" } },
    observedObjects: { type: "array", items: { type: "string" } },
    obstacles: { type: "array", items: { type: "string" } },
    repetitiveActions: { type: "array", items: { type: "string" } },
    requirements: { type: "array", items: { type: "string" } },
    followUpQuestions: { type: "array", items: { type: "string" } },
    robotCapabilitiesNeeded: { type: "array", items: { type: "string" } },
    frames: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          detections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                category: {
                  type: "string",
                  enum: [
                    "Worker / Human",
                    "Tool or machine",
                    "Work area",
                    "Terrain / environment",
                    "Obstacle",
                    "Relevant object",
                  ],
                },
                box_2d: { type: "array", items: { type: "integer" } },
              },
              required: ["label", "category", "box_2d"],
            },
          },
        },
        required: ["index", "detections"],
      },
    },
  },
  required: [
    "taskSummary",
    "environment",
    "observedObjects",
    "obstacles",
    "repetitiveActions",
    "requirements",
    "followUpQuestions",
    "robotCapabilitiesNeeded",
    "frames",
  ],
};

const PROMPT = `You are analyzing sampled frames from a short work video for
Rivet, a robotics-bounty marketplace for infrastructure, facilities,
lawn-care and pest-control operators. The images given are frames sampled
in order from one continuous work video (frame 0 is earliest).

Identify the manual work task being performed and what it would take to
automate it with a robot. For each frame, detect the prominent items in
these categories only: "Worker / Human", "Tool or machine", "Work area",
"Terrain / environment", "Obstacle", "Relevant object". For every detection
give box_2d as [ymin, xmin, ymax, xmax] normalized to a 0-1000 scale,
relative to that frame's own image dimensions.

Only report what the frames actually show. If something about the task,
environment or constraints is unclear from the video, say so in
followUpQuestions instead of guessing — do not invent facts not supported
by the images. taskSummary should be one or two plain sentences. Keep each
array entry short (a few words to one short sentence).`;

const fail = (res, status, error, message) => res.status(status).json({ error, message });

// Stable per-visitor key without storing the IP: HMAC with the server secret.
function visitorKey(req, secret) {
  const h = req.headers || {};
  const ip = String(h["x-vercel-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-for"] || "unknown")
    .split(",")[0].trim();
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

// Ask Convex for one unit of video budget, as the signed-in visitor. Any problem means
// "no": fail closed.
async function reserveBudget(convexUrl, secret, clientKey, userToken) {
  try {
    const r = await fetch(`${convexUrl.replace(/\/+$/, "")}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ path: "aiBudget:reserveVideo", args: { secret, clientKey }, format: "json" }),
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

// Validated frames as { mimeType, data }, or { error } for a malformed or oversized request.
function readFrames(body) {
  const raw = body?.frames;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "frames (array of data URLs) is required" };
  if (raw.length > MAX_FRAMES) return { error: `At most ${MAX_FRAMES} frames are allowed.` };
  let total = 0;
  const frames = [];
  for (const f of raw) {
    if (typeof f !== "string") return { error: "Each frame must be an image data URL." };
    if (f.length > MAX_FRAME_CHARS + 64) return { error: "A frame is too large.", status: 413 };
    total += f.length;
    if (total > MAX_TOTAL_CHARS) return { error: "The frames are too large together.", status: 413 };
    const m = DATA_URL.exec(f);
    if (!m || !IMAGE_TYPES.has(m[1])) return { error: "Frames must be JPEG, PNG or WebP data URLs." };
    frames.push({ mimeType: m[1], data: m[2] });
  }
  return { frames };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const { VIDEO_ENABLED, GEMINI_API_KEY, CONVEX_URL, RIVET_SERVER_SECRET } = process.env;
  if (VIDEO_ENABLED !== "true" || !GEMINI_API_KEY || !CONVEX_URL || !RIVET_SERVER_SECRET) {
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
  const read = readFrames(body);
  if (read.error) return fail(res, read.status ?? 400, "bad_request", read.error);
  const inlineFrames = read.frames;

  // Budget is reserved only for a well-formed request, and before Gemini is called.
  const budget = await reserveBudget(CONVEX_URL, RIVET_SERVER_SECRET, visitorKey(req, RIVET_SERVER_SECRET), bearer[1]);
  if (!budget.ok) {
    if (budget.reason === "unauthenticated") return fail(res, 401, "unauthenticated", SIGN_IN);
    if (budget.reason === "not_client") return fail(res, 403, "forbidden", "Video analysis is for Client accounts.");
    if (budget.reason === "no_account") return fail(res, 403, "no_account", "Finish setting up your Rivet account to analyze a video.");
    return budget.reason === "unavailable"
      ? fail(res, 503, "unavailable", UNAVAILABLE)
      : fail(res, 429, "limit", "Video analysis has reached its limit for today.");
  }

  const parts = [{ text: PROMPT }];
  inlineFrames.forEach((f, i) => {
    parts.push({ text: `Frame ${i}:` });
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const FAILED = "The video analysis couldn't be completed just now.";

  try {
    // The key goes in a header (not the URL) so it can't end up in logs or error text.
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
          },
        }),
        signal: controller.signal,
      }
    );

    // Never pass Gemini's error text to the browser.
    if (!r.ok) return fail(res, 502, "failed", FAILED);

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) return fail(res, 502, "failed", FAILED);

    let analysis;
    try {
      analysis = JSON.parse(text);
    } catch {
      return fail(res, 502, "failed", FAILED);
    }

    return res.status(200).json({ analysis });
  } catch (err) {
    return err?.name === "AbortError"
      ? fail(res, 504, "timeout", "The video analysis took too long.")
      : fail(res, 500, "failed", FAILED);
  } finally {
    clearTimeout(timeout);
  }
}

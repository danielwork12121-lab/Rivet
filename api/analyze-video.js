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
// Env var required: GEMINI_API_KEY (set in Vercel -> Project Settings ->
// Environment Variables). Until it's set, this returns 500 and the Video
// Input tab shows a clear "analysis unavailable" error — upload/preview
// still works either way.
//
// Note: adding/changing an env var in the Vercel dashboard does not affect
// deployments that already built before the change -- a new deployment is
// required to pick it up. This comment bump exists to force that redeploy.

const MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 25000; // keep under vercel.json's maxDuration: 30 for this function
const MAX_FRAMES = 8;

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

function dataUrlToInline(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const rawFrames = Array.isArray(body?.frames) ? body.frames.slice(0, MAX_FRAMES) : [];
  const inlineFrames = rawFrames.map(dataUrlToInline).filter(Boolean);
  if (inlineFrames.length === 0) {
    return res.status(400).json({ error: "frames (array of data URLs) is required" });
  }

  const parts = [{ text: PROMPT }];
  inlineFrames.forEach((f, i) => {
    parts.push({ text: `Frame ${i}:` });
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(502).json({ error: "Gemini API error", detail: errText.slice(0, 300) });
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) {
      return res.status(502).json({ error: "Empty response from model" });
    }

    let analysis;
    try {
      analysis = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Model did not return valid JSON" });
    }

    return res.status(200).json({ analysis });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return res.status(timedOut ? 504 : 500).json({ error: timedOut ? "Request timed out" : "Request failed" });
  } finally {
    clearTimeout(timeout);
  }
}

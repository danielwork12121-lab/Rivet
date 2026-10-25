// Tells the pages which Convex backend to use, so the URL isn't hard-coded in the
// repo. Set CONVEX_URL in Vercel → Project Settings → Environment Variables to the
// deployment URL, e.g. https://happy-otter-123.convex.cloud. Not a secret: the
// browser talks to that URL directly.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ convexUrl: process.env.CONVEX_URL || null });
}

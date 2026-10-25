// Optional override for which Convex backend the pages use. Leave it empty: hosted
// sites get the URL from /api/config (the CONVEX_URL setting in Vercel), and local
// pages fall back to `npx convex dev` at http://127.0.0.1:3210.
window.RIVET_CONVEX_URL = window.RIVET_CONVEX_URL || "";

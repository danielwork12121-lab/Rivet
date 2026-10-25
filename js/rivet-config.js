// Which Convex backend the Rivet pages talk to. One fixed, visible rule:
//   - this machine (localhost, 127.0.0.1 or a file:// page) -> "local": http://127.0.0.1:3210
//     (npx convex dev)
//   - a hosted site (e.g. Vercel)                            -> "cloud": whatever that site's
//     /api/config returns, i.e. the CONVEX_URL setting of that Vercel environment. js/rivet-api.js
//     asks for it at runtime, so the repo names no deployment. Production and Preview each set
//     their own; a preview should point at an isolated deployment.
//   - a URL injected before this script (tests only) wins, and is labelled "custom".
// RIVET_BACKEND names it, for labels ("Saved to Rivet (cloud)") and per-backend storage keys, so
// environments are never mixed silently. Deployment URLs are public, not secrets. There is no
// ?backend= override: a page sends the visitor's sign-in token to its backend, so a link must not
// be able to point it anywhere else. Load this before js/rivet-api.js.
(function (root) {
  "use strict";
  if (root.RIVET_CONVEX_URL) { root.RIVET_BACKEND = root.RIVET_BACKEND || "custom"; return; }
  var host = (root.location && root.location.hostname) || "";
  var onThisMachine = host === "" || host === "localhost" || host === "127.0.0.1";
  root.RIVET_BACKEND = onThisMachine ? "local" : "cloud";
  if (onThisMachine) root.RIVET_CONVEX_URL = "http://127.0.0.1:3210";
})(typeof globalThis !== "undefined" ? globalThis : window);

// Clerk (sign-in). The publishable key is public by design; it names the Clerk
// instance (Development: relevant-kingfish-8271). Secret keys never go in files
// the browser loads. Load js/rivet-auth.js after this script.
(function (root) {
  "use strict";
  if (!root.RIVET_CLERK_PUBLISHABLE_KEY) {
    root.RIVET_CLERK_PUBLISHABLE_KEY = "pk_test_cmVsZXZhbnQta2luZ2Zpc2gtODI3MS5jbGVyay5hY2NvdW50cy5kZXYk";
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

// Which Convex backend the Rivet pages talk to. One fixed, visible rule:
//   - localhost, 127.0.0.1 or a file:// page -> "local" (npx convex dev on this machine)
//   - the production site, rivet-rose.vercel.app / any other host -> "cloud" (the shared
//     Convex Cloud dev deployment)
//   - TEMPORARY, REMOVE BEFORE MERGING TO PRODUCTION: any other *.vercel.app host, i.e. a
//     branch preview -> "preview", an isolated Convex deployment, so a preview of the
//     sign-in work can never read or write the shared backend. Unknown preview hosts fail
//     safe (isolated), never shared.
//   - ?backend=local or ?backend=cloud in the page URL overrides, for testing. The page
//     sends the visitor's sign-in token to its backend, so a link may not point it at their
//     machine ("local" only on this machine) and a preview may not be pointed at the shared
//     backend ("cloud" only off preview hosts).
// The page shows which one it uses ("Saved to Rivet (cloud)"), and each backend keeps
// its own saved draft, so environments are never mixed silently. Deployment URLs are
// public, not secrets. Load this before js/rivet-api.js.
(function (root) {
  "use strict";
  var BACKENDS = {
    local: "http://127.0.0.1:3210",
    cloud: "https://coordinated-canary-9.convex.cloud",
    preview: "https://woozy-warbler-733.convex.cloud", // isolated: project rivet-auth-preview
  };
  var PRODUCTION_HOSTS = ["rivet-rose.vercel.app"];
  // A URL injected before this script (tests only) wins, and is labelled "custom".
  if (root.RIVET_CONVEX_URL) { root.RIVET_BACKEND = root.RIVET_BACKEND || "custom"; return; }
  var loc = root.location || {};
  var host = loc.hostname || "";
  var onThisMachine = host === "" || host === "localhost" || host === "127.0.0.1";
  var onPreviewHost = /\.vercel\.app$/.test(host) && PRODUCTION_HOSTS.indexOf(host) === -1;
  var requested = null;
  try { requested = new URLSearchParams(loc.search || "").get("backend"); } catch (e) { /* old browser */ }
  if (requested === "local" && !onThisMachine) requested = null;
  if (requested === "cloud" && onPreviewHost) requested = null;
  if (requested === "preview" && !onPreviewHost) requested = null;
  var name = Object.prototype.hasOwnProperty.call(BACKENDS, requested) ? requested : onThisMachine ? "local" : onPreviewHost ? "preview" : "cloud";
  root.RIVET_BACKEND = name;
  root.RIVET_CONVEX_URL = BACKENDS[name];
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

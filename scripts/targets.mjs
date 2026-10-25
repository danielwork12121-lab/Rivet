// Which Convex backend a live test run uses. Always explicit: RIVET_TARGET=local | cloud.
// URLs come from js/rivet-config.js, the same table the pages use. The run refuses to
// start if the Convex CLI (used for admin reads like `npx convex data`) points
// somewhere else, so one run never mixes two backends.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url);

function urlFor(name) {
  const sandbox = { location: { hostname: "localhost", search: `?backend=${name}` }, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(new URL("js/rivet-config.js", ROOT), "utf8"), sandbox);
  return sandbox.RIVET_BACKEND === name ? sandbox.RIVET_CONVEX_URL : null;
}

export function resolveTarget() {
  const name = process.env.RIVET_TARGET;
  const url = name && urlFor(name);
  if (!url) {
    console.error("Choose the backend explicitly: RIVET_TARGET=local or RIVET_TARGET=cloud (see js/rivet-config.js).");
    process.exit(2);
  }
  let cli = null;
  try { cli = readFileSync(new URL(".env.local", ROOT), "utf8").match(/^CONVEX_URL=(\S+)/m)?.[1] ?? null; } catch { /* none */ }
  if (cli !== url) {
    console.error(`RIVET_TARGET=${name} is ${url}, but the Convex CLI (.env.local) points at ${cli}. Refusing to mix backends.`);
    process.exit(2);
  }
  console.log(`Target backend: ${name} (${url})`);
  return { name, url };
}

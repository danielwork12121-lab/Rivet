// Syntax-checks every HTML page in the repo root and pages/ without running it.
// Classic <script> blocks share one global scope, so each page's local scripts are
// also compiled together: that is what catches a duplicate top-level `const`
// introduced by two branches that merged without a textual conflict.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const pages = [
  ...readdirSync(root).filter((f) => f.endsWith(".html")),
  ...readdirSync(join(root, "pages")).filter((f) => f.endsWith(".html")).map((f) => `pages/${f}`),
];
let failed = 0;

function compile(label, code) {
  try {
    new vm.Script(code, { filename: label });
    return true;
  } catch (e) {
    console.log(`FAIL  ${label}: ${e.name}: ${e.message}`);
    failed++;
    return false;
  }
}

for (const page of pages) {
  const html = readFileSync(join(root, page), "utf8");
  const parts = [];
  const before = failed;
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    // Only blocks a browser runs as classic scripts. Modules have their own scope, and
    // other types (JSON, templates, bundler data) are never executed.
    const type = attrs.match(/type=["']?([^"'\s>]+)/)?.[1]?.toLowerCase();
    // JSON data blocks (incl. the site's exported bundles) must parse, or the page's
    // own loader fails: a stray raw newline once froze find-solution on "Loading...".
    if (type && (type.includes("json") || type.startsWith("__bundler/"))) {
      let data;
      try { data = JSON.parse(m[2]); } catch (e) { console.log(`FAIL  ${page} <script type="${type}">: invalid JSON: ${e.message}`); failed++; }
      // The exported template carries each page's component logic (<script type="text/x-dc">),
      // which the page runtime compiles the same way as below.
      if (type === "__bundler/template" && typeof data === "string") {
        for (const c of data.matchAll(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/g)) {
          try { new vm.Script(`(function (DCLogic, StreamableLogic, React) {\n${c[1]}\n;return Component; })`, { filename: `${page} x-dc` }); }
          catch (e) { console.log(`FAIL  ${page} component logic: ${e.name}: ${e.message}`); failed++; }
        }
      }
      continue;
    }
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
    if (src && /^https?:/.test(src)) continue;
    const label = src ? `${page} -> ${src}` : `${page} inline #${parts.length + 1}`;
    // "/x.js" is relative to the site root, "x.js" to the page's own folder.
    const file = src && (src.startsWith("/") ? join(root, src) : join(root, dirname(page), decodeURIComponent(src)));
    const code = src ? readFileSync(file, "utf8") : m[2];
    if (compile(label, code)) parts.push(code);
  }
  // Separate scripts in one page behave like one program for top-level let/const/class.
  if (failed > before) continue;
  if (parts.length > 1 && !compile(`${page} (all scripts together)`, parts.join(";\n"))) continue;
  console.log(`ok    ${page} (${parts.length} script${parts.length === 1 ? "" : "s"})`);
}

console.log(failed ? `\n${failed} problem(s)` : "\nAll pages compile");
process.exit(failed ? 1 : 0);

// Syntax-checks every HTML page in the repo root without running it.
// Classic <script> blocks share one global scope, so each page's local scripts are
// also compiled together: that is what catches a duplicate top-level `const`
// introduced by two branches that merged without a textual conflict.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const pages = readdirSync(root).filter((f) => f.endsWith(".html"));
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
    if (/type=["']?module/.test(attrs)) continue; // none today; modules have their own scope
    const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
    if (src && /^https?:/.test(src)) continue;
    const label = src ? `${page} -> ${src}` : `${page} inline #${parts.length + 1}`;
    const code = src ? readFileSync(join(root, decodeURIComponent(src)), "utf8") : m[2];
    if (compile(label, code)) parts.push(code);
  }
  // Separate scripts in one page behave like one program for top-level let/const/class.
  if (failed > before) continue;
  if (parts.length > 1 && !compile(`${page} (all scripts together)`, parts.join(";\n"))) continue;
  console.log(`ok    ${page} (${parts.length} script${parts.length === 1 ? "" : "s"})`);
}

console.log(failed ? `\n${failed} problem(s)` : "\nAll pages compile");
process.exit(failed ? 1 : 0);

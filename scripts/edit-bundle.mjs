// Safe editing of the self-extracting bundle pages in pages/*.html.
// The real page HTML is a JSON string inside <script type="__bundler/template">.
// This decodes it, lets a callback edit the HTML, re-encodes it and splices it back
// in place, leaving the rest of the file byte-identical.
//
//   import { editBundle, dumpTemplate } from "./edit-bundle.mjs";
//   editBundle("pages/engineers.html", (html) => html.replace("a", "b"));
//
// CLI:  node scripts/edit-bundle.mjs dump pages/engineers.html > out.html
import { readFileSync, writeFileSync } from "node:fs";

const RE = /(<script type="__bundler\/template"[^>]*>)([\s\S]*?)(<\/script>)/;

export function dumpTemplate(file) {
  const m = readFileSync(file, "utf8").match(RE);
  if (!m) throw new Error(`${file}: no __bundler/template`);
  return JSON.parse(m[2]);
}

// Two encodings exist in this repo, and both must keep "</" out of the string so it can
// sit inside a <script> element: style A (find-solution) escapes non-ASCII as \uXXXX and
// writes "<\/"; style B (the other bundles) keeps non-ASCII raw and writes "<\u002F".
export function encode(html, style = "A") {
  const j = JSON.stringify(html);
  if (style === "B") return j.replace(/<\//g, "<\\u002F");
  return j.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).replace(/<\//g, "<\\/");
}

export function editBundle(file, fn) {
  const src = readFileSync(file, "utf8");
  const m = src.match(RE);
  if (!m) throw new Error(`${file}: no __bundler/template`);
  const before = JSON.parse(m[2]);
  const after = fn(before);
  if (typeof after !== "string") throw new Error("edit callback must return the html string");
  if (after === before) { console.log(`${file}: unchanged`); return false; }
  const [, lead, body, trail] = m[2].match(/^(\s*)([\s\S]*?)(\s*)$/);
  const style = body.includes("\\u002F") ? "B" : "A";
  if (encode(before, style) !== body) throw new Error(`${file}: re-encoding is not byte-identical; refusing to edit`);
  const i = m.index + m[1].length;
  writeFileSync(file, src.slice(0, i) + lead + encode(after, style) + trail + src.slice(i + m[2].length));
  console.log(`${file}: updated`);
  return true;
}

// Replace exactly-one occurrence; throws if the anchor is missing or ambiguous.
export function replaceOnce(html, from, to) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, found ${n}: ${from.slice(0, 80)}`);
  return html.replace(from, () => to);
}

if (process.argv[1] && process.argv[1].endsWith("edit-bundle.mjs") && process.argv[2] === "dump") {
  process.stdout.write(dumpTemplate(process.argv[3]));
}

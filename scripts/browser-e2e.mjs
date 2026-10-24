// Real-browser checks for Robot Bounty Client Flow.html against the LOCAL Convex backend.
//
//   npx convex dev            # terminal 1, keep running
//   npm run e2e:browser       # terminal 2
//
// No extra dependencies: serves the repo on 127.0.0.1 with node:http, drives the system
// Chrome (or CHROME_PATH) over the DevTools protocol with Node's built-in WebSocket, and
// counts rows with `npx convex data` (admin access to the local dev deployment only).
// Uses fictional company names and leaves those rows in the local dev database.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const PAGE_PATH = "/Robot%20Bounty%20Client%20Flow.html";
const RUN = Date.now().toString(36);

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- infrastructure -----------------------------------------------------------------
function startServer() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "rivet-e2e-"));
  const proc = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  return {
    cdp: `http://127.0.0.1:${port}`,
    async close() {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await Promise.race([exited, sleep(5000)]);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function openTab(cdp, pageUrl, preload) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") {
      const x = d.params.exceptionDetails;
      errors.push(x.exception?.description ?? x.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  if (preload) await send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.result.value;
  };
  const waitFor = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; } catch {} await sleep(100); }
    return false;
  };
  const load = async () => {
    await send("Page.navigate", { url: pageUrl });
    if (!(await waitFor("document.readyState === 'complete' && typeof render === 'function'", 10000))) {
      throw new Error("page did not load: " + errors.join(" | "));
    }
  };
  await load();
  return {
    ev, waitFor, errors, reload: load,
    close: () => { ws.close(); return fetch(`${cdp}/json/close/${t.id}`); },
  };
}

// Admin read of the local dev table; no public query involved.
function rowsFor(company) {
  const out = execFileSync("npx", ["convex", "data", "operatorRequests", "--limit", "10000", "--format", "jsonLines"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
    .filter((r) => r.profile?.companyName === company);
}

// ---- page helpers -------------------------------------------------------------------
// Start a tab with empty storage. Runs once per tab (guarded by sessionStorage, which
// survives reloads), so a later reload still sees what the page saved.
const FRESH = `if (!sessionStorage.getItem("e2e-fresh")) { localStorage.clear(); sessionStorage.setItem("e2e-fresh", "1"); }`;
const setVal = (sel, v) =>
  `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;
const onStep = (n) => `S.role === "client" && S.step === ${n}`;
const stepper = (n) => `document.querySelectorAll("#steps button")[${n}].click()`;
const noticeHas = (text) => `(document.querySelector(".notice")?.textContent ?? "").includes(${JSON.stringify(text)})`;

// ---- scenarios ----------------------------------------------------------------------
async function main() {
  try { await fetch(`${CONVEX_URL}/version`); } catch {
    console.error(`Convex backend not reachable at ${CONVEX_URL}. Start it with \`npx convex dev\`.`);
    process.exit(2);
  }
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${server.address().port}${PAGE_PATH}`;
  const chrome = await launchChrome();
  const tabs = [];
  const open = async (preload) => { const t = await openTab(chrome.cdp, pageUrl, preload); tabs.push(t); return t; };
  try {
    // 1. Load and save the intake
    const company = `Fictional E2E Lawn ${RUN}`;
    let tab = await open(FRESH);
    check("page loads with no script errors", tab.errors.length === 0 && (await tab.ev("typeof RivetApi")) === "object", tab.errors.join(" | "));
    check("Client/Developer role toggle is present", (await tab.ev(`document.querySelectorAll("#role button").length`)) === 2);
    await tab.ev(setVal("#f-name", company));
    const sync = await tab.ev(`(() => { document.querySelector("#next").click(); const b = document.querySelector("#next"); return { disabled: b.disabled, text: b.textContent }; })()`);
    check("Continue shows a disabled Saving state immediately", sync.disabled && /Saving/.test(sync.text), JSON.stringify(sync));
    await tab.ev(`document.querySelector("#next")?.click(); document.querySelector("#next")?.click();`);
    check("advances to follow-ups only after Convex confirms", await tab.waitFor(onStep(1)));
    check("three clicks stored exactly one request", rowsFor(company).length === 1, `rows=${rowsFor(company).length}`);

    // 2. Client navigation through all five steps
    for (let i = 0; i < 3; i++) {
      await tab.ev(`document.querySelector('.chip[data-q="${i}"]').click()`);
      await sleep(50);
    }
    check("answering all follow-ups enables the next button", await tab.ev(`!document.querySelector("#next").disabled`));
    await tab.ev(click("#next"));
    check("follow-ups -> opportunities", await tab.waitFor(onStep(2)));
    await tab.ev(click("[data-bounty]"));
    check("opportunities -> request a bounty", await tab.waitFor(`${onStep(4)} && !!document.querySelector("#post")`));
    await tab.ev(click("#post"));
    check("bounty posts in the demo view", await tab.waitFor(`S.posted && !!document.querySelector("#restart")`));
    for (const n of [0, 1, 2, 3, 4]) {
      await tab.ev(stepper(n));
      check(`client stepper opens step ${n + 1}`, await tab.waitFor(onStep(n)));
    }
    check("revisiting a saved, unchanged intake via the stepper adds no request", rowsFor(company).length === 1);

    // 3. Developer role, all screens, and back
    await tab.ev(`document.querySelector('#role [data-role="dev"]').click()`);
    check("Developer role opens the team profile", await tab.waitFor(`S.role === "dev" && S.dstep === 0 && !!document.querySelector("#d-team")`));
    await tab.ev(click("#next"));
    check("profile -> bounty board", await tab.waitFor(`S.dstep === 1`));
    check("board shows the bounty posted on the client side", await tab.ev(`document.body.innerText.includes("posted from the client side")`));
    await tab.ev(click("[data-sel]"));
    check("board -> claim", await tab.waitFor(`S.dstep === 2 && !!document.querySelector("#claim")`));
    await tab.ev(click("#claim"));
    check("claim -> build & deliver", await tab.waitFor(`S.dstep === 3 && !!document.querySelector("#post-u")`));
    await tab.ev(click("#post-u"));
    check("developer can post a milestone update", await tab.waitFor(`S.claim.milestones[0].done === true`));
    for (const n of [0, 1, 2, 3]) {
      await tab.ev(stepper(n));
      check(`developer stepper opens step ${n + 1}`, await tab.waitFor(`S.role === "dev" && S.dstep === ${n}`));
    }
    await tab.ev(`document.querySelector('#role [data-role="client"]').click()`);
    check("switching back to Client keeps the client step", await tab.waitFor(onStep(4)));
    check("no script errors across both roles", tab.errors.length === 0, tab.errors.join(" | "));

    // 4. Refresh restores the saved intake
    await tab.reload();
    check("after a refresh the intake is restored", await tab.waitFor(`document.querySelector("#f-name")?.value === ${JSON.stringify(company)}`));
    check("restored intake shows the saved confirmation", await tab.waitFor(`document.body.innerText.includes("Saved to Rivet")`));
    await tab.close();

    // 5. Leaving step 1 through the stepper saves first
    const company2 = `Fictional E2E Pest ${RUN}`;
    tab = await open(FRESH);
    await tab.ev(setVal("#f-name", company2));
    await tab.ev(stepper(3));
    check("stepper jump from step 1 saves, then lands on the chosen step", await tab.waitFor(onStep(3)));
    check("...with exactly one request", rowsFor(company2).length === 1);
    await tab.close();

    // 6. Empty description: error, no save, no success
    const company3 = `Fictional E2E Empty ${RUN}`;
    tab = await open(FRESH);
    await tab.ev(setVal("#f-name", company3));
    await tab.ev(setVal("#f-desc", "   "));
    await tab.ev(click("#next"));
    check("empty description shows an error and stays on step 1", await tab.waitFor(`${noticeHas("describe a normal week")} && ${onStep(0)}`));
    check("...with no success toast and nothing stored",
      !(await tab.ev(`/saved/i.test(document.querySelector("#toast").textContent)`)) && rowsFor(company3).length === 0);
    await tab.close();

    // 7. Backend unreachable: error, no success, retry possible
    tab = await open(`${FRESH} window.RIVET_CONVEX_URL = "http://127.0.0.1:1";`);
    await tab.ev(click("#next"));
    check("unreachable backend shows a connection error", await tab.waitFor(noticeHas("Can't reach the Rivet server")));
    check("...stays on step 1, button usable, nothing marked saved",
      await tab.ev(`${onStep(0)} && !document.querySelector("#next").disabled && localStorage.getItem("rivet.intake.requestId") === null`));
    await tab.close();

    // 8. Markup typed by a user stays inert after a round trip
    const evil = `<img src=x onerror="window.__xss=1">${RUN}`;
    tab = await open(FRESH);
    await tab.ev(setVal("#f-name", evil));
    await tab.ev(click("#next"));
    await tab.waitFor(onStep(1));
    await tab.reload();
    await tab.waitFor(`document.querySelector("#f-name")?.value === ${JSON.stringify(evil)}`);
    await sleep(300);
    check("stored markup is shown as text and never executed",
      await tab.ev(`window.__xss === undefined && !document.querySelector("#app img") && document.querySelector("#f-name").value === ${JSON.stringify(evil)}`));
    await tab.close();
  } finally {
    for (const t of tabs) await t.close().catch(() => {});
    await chrome.close();
    server.close();
  }
  console.log(failed ? `\n${failed} browser check(s) FAILED` : "\nAll browser checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

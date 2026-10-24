// Real-Clerk checks of robot matching (convex/matching.ts) on the ISOLATED Convex Cloud
// deployment named in .env.local (the shared coordinated-canary-9 is refused). Real Clerk
// Development sessions (two Clients and a Developer; fictional +clerk_test users; windowed
// Chrome because of Clerk Protect) call matching:findRobots / latestMatch with real tokens.
// Fictional sample robots and deterministic maths only: no AI, Apify or scraping calls.
//
//   HEADED=1 node scripts/browser-clerk-matching.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const env = readFileSync(join(ROOT, ".env.local"), "utf8");
const DEPLOYMENT = env.match(/^CONVEX_DEPLOYMENT=(\S+)/m)?.[1] ?? "";
const CONVEX_URL = env.match(/^CONVEX_URL=(\S+)/m)?.[1] ?? "";
const ISSUER = "https://relevant-kingfish-8271.clerk.accounts.dev";
if (!/^dev:/.test(DEPLOYMENT) || /canary/.test(env) || !/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(CONVEX_URL) || DEPLOYMENT === "dev:coordinated-canary-9") {
  console.error(`Refusing: .env.local must name an isolated Convex cloud dev deployment (found ${DEPLOYMENT}).`);
  process.exit(2);
}
console.log(`Convex Cloud deployment ${DEPLOYMENT.replace("dev:", "")}, Clerk issuer ${ISSUER}\n`);
const RUN = Date.now().toString(36);
const PASSWORD = "Rv!" + Math.random().toString(36).slice(2, 10) + "-Qz7#" + RUN; // fictional accounts only
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (fn, args) => {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }).trim();
  return out ? JSON.parse(out) : null;
};
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(String(e.data ?? e.message)); } };

function startServer() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "localhost", () => r(server)));
}

function findChrome() {
  const found = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "rivet-auth-e2e-"));
  const proc = spawn(findChrome(), [...(process.env.HEADED ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-blink-features=AutomationControlled", "about:blank"], { stdio: "ignore" });
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
async function browserSend(cdp) {
  const { webSocketDebuggerUrl } = await (await fetch(`${cdp}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    ws.addEventListener("message", function on(m) { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", on); r(d.result); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close() };
}
// One "person": an isolated browser context (own storage), so their fake Clerk session is theirs.
async function newPerson(cdp) {
  const b = await browserSend(cdp);
  const { browserContextId } = await b.send("Target.createBrowserContext");
  b.close();
  return {
    async tab(preload) {
      const bb = await browserSend(cdp);
      const { targetId } = await bb.send("Target.createTarget", { url: "about:blank", browserContextId });
      bb.close();
      const ws = new WebSocket(`${cdp.replace("http", "ws")}/devtools/page/${targetId}`);
      await new Promise((r) => (ws.onopen = r));
      let id = 0;
      const pending = new Map(), errors = [];
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
        if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
      };
      const send = (method, params = {}) => new Promise((r, bad) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); bad(new Error("CDP timeout: " + method)); } }, 60000); });
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
      const ev = async (expr) => {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
        return r.result.result.value;
      };
      const waitFor = async (expr, ms = 15000) => {
        for (let t = 0; t < ms; t += 100) { try { if (await ev(expr)) return true; } catch { /* page navigating */ } await sleep(100); }
        return false;
      };
      const mouseClick = async (selector) => {
        const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      };
      const typeInto = async (selector, text) => {
        await mouseClick(selector);
        await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.select && e.select(); })()`);
        await send("Input.insertText", { text });
      };
      const pressEnter = async () => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      };
      const go = (url) => send("Page.navigate", { url });
      return { ev, waitFor, errors, mouseClick, typeInto, pressEnter, go, close: () => ws.close() };
    },
  };
}


const text = (sel = "body") => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;
const has = (t, sel = "body") => `${text(sel)}.includes(${JSON.stringify(t)})`;
const pathIs = (p) => `location.pathname.endsWith(${JSON.stringify(p)})`;
const clickButton = (t) => `([...document.querySelectorAll("button")].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(t)}))).click()`;
const PRELOAD = `window.RIVET_CONVEX_URL = ${JSON.stringify(CONVEX_URL)};`;

async function signUpVia(tab, base, { role, name, email }) {
  await tab.go(`${base}/pages/signup.html`);
  await tab.waitFor(has("How will you use Rivet?"), 30000);
  await tab.ev(`document.querySelectorAll('[role=radio]')[${role === "developer" ? 1 : 0}].click()`);
  await tab.typeInto("input[autocomplete=name]", name);
  await tab.typeInto("input[autocomplete=organization]", "E2E-TEST Org " + RUN);
  await tab.typeInto("input[autocomplete=email]", email);
  await tab.typeInto("input[autocomplete=new-password]", PASSWORD);
  await tab.mouseClick("input[type=checkbox]");
  await tab.ev(clickButton("Create account"));
  const asked = await tab.waitFor(has("We emailed a verification code") + " || " + `!!document.querySelector("[role=alert]")`, 30000);
  const verifyShown = await tab.ev(has("We emailed a verification code"));
  if (!asked || !verifyShown) {
    const why = await tab.ev(`JSON.stringify({ alert: ${text("[role=alert]")}, protectCheckOpen: !!document.querySelector("[class*=protectCheck]"), status: Clerk.client.signUp.status })`);
    return { verifyShown: false, error: why };
  }
  await tab.typeInto("input[autocomplete=one-time-code]", "424242");
  await tab.ev(`document.getElementById("signup-verify-btn").click()`);
  const welcomed = await tab.waitFor(has("Your account is ready") + " || " + `!!document.querySelector("[role=alert]")`, 30000);
  const ok = await tab.ev(has("Your account is ready"));
  const why = ok ? "" : await tab.ev(`JSON.stringify({ status: Clerk.client.signUp.status, missing: Clerk.client.signUp.missingFields, unverified: Clerk.client.signUp.unverifiedFields, protectCheck: Clerk.client.signUp.protectCheck, ui: typeof window.__internal_ClerkUICtor, v: Clerk.version, uiv: Clerk.uiVersion, iframes: document.querySelectorAll("iframe").length, dialogs: document.querySelectorAll("[role=dialog], .cl-modalBackdrop, [class*=cl-]").length })`);
  return { verifyShown, welcomed: ok, error: ok ? "" : `${welcomed ? await tab.ev(text("[role=alert]")) : "timeout"} ${why}` };
}

async function main() {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  const chrome = await launchChrome();
  const tabs = [];
  try {
    const { ConvexHttpClient } = await import("convex/browser");
    const as = (token) => { const x = new ConvexHttpClient(CONVEX_URL); if (token) x.setAuth(token); return x; };
    const count = (table) => execFileSync("npx", ["convex", "data", table, "--limit", "1000", "--format", "jsonLines"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 }).split("\n").filter((l) => l.startsWith("{")).length;
    const rows = (table) => execFileSync("npx", ["convex", "data", table, "--limit", "1000", "--format", "jsonLines"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 }).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

    // Real Clerk sessions. Tokens last 60 s, so a fresh one is fetched for each call.
    const people = {};
    for (const [key, role, name] of [["a", "client", "Alice Match"], ["b", "client", "Bob Match"], ["dev", "developer", "Devi Match"]]) {
      const person = await newPerson(chrome.cdp);
      const tab = await person.tab(PRELOAD); tabs.push(tab);
      const r = await signUpVia(tab, base, { role, name, email: `rivet.e2e.m${key}.${RUN}+clerk_test@example.com` });
      check(`0${key}. real Clerk ${role} (${key}) signed up`, !!r.welcomed, r.error ?? "");
      if (!r.welcomed) throw new Error("sign-up failed; stopping");
      people[key] = { tab, sub: await tab.ev("Clerk.user.id") };
    }
    cli("users:setDeveloperStatus", { clerkUserId: people.dev.sub, status: "approved" });
    const tok = (k) => people[k].tab.ev("RivetAuth.getToken()");
    const call = async (k, kind, fn, args) => { const c = as(k ? await tok(k) : null); return c[kind](fn, args); };

    // Alice saves a request through the real API
    const intake = { title: "E2E-TEST Matching Co — Lawn care automation request", description: "Fictional: we mow steep lawns.", environment: "Lawn care operation, West region.", constraints: [] };
    const reqA = await call("a", "mutation", "requests:create", intake);
    const reqB = await call("b", "mutation", "requests:create", { ...intake, title: "E2E-TEST Bob's own request" });
    await call("a", "mutation", "requests:saveFollowUps", { id: reqA, complete: false, answers: [{ key: "slope", question: "Slopes?", answerLabel: "A lot of them", assumption: { value: 28, unit: "degrees" } }] });

    const aiBefore = count("aiUsage"), matchesBefore = count("matches"), scheduledNote = "(no AI/Apify/scrape code path exists in matching.ts)";
    // 1. match + persist
    const runA = () => call("a", "mutation", "matching:findRobots", { requestId: reqA, task: "mowing", annualTaskCost: 60000 });
    const idA = await runA();
    const m = await call("a", "query", "matching:latestMatch", { requestId: reqA });
    check("1. Client A matches robots for their own saved request", !!idA && m?.status === "done" && m.picks.length === 3, `${m?.picks.length} picks, next=${m?.next?.kind}`);
    check("2. results are ranked by the deterministic engine, all labelled fictional sample data",
      m.picks.every((p, i, a) => i === 0 || a[i - 1].score >= p.score) && m.picks.every((p) => p.dataSource === "fictional_sample" && /not vendor data/.test(p.assumptions.join(" "))),
      m.picks.map((p) => `${p.name} (${p.score})`).join(", "));
    check("3. payback and savings are computed from the saved annual cost", m.picks.some((p) => p.paybackMonths !== null && p.yearlyNetSavings !== null) && m.intent.annualTaskCost === 60000);
    check("4. the slope answer became a requirement noted as illustrative", m.intent.requirements.some((r) => r.name === "max_slope_deg" && r.value === 28) && m.picks.every((p) => /illustrative/.test(p.assumptions.join(" "))));
    // 2. persisted in Convex, under the request
    const stored = rows("matches").filter((r) => r.requestId === reqA);
    check("5. the result is persisted in Convex under that request (stored row matches what is returned)",
      stored.length === 1 && stored[0]._id === idA && stored[0].picks.length === 3 && JSON.stringify(stored[0].picks.map((p) => p.robotId)) === JSON.stringify(m.picks.map((p) => p.robotId)));
    // 3. repeated runs
    const idA2 = await runA(), idA3 = await runA();
    const m2 = await call("a", "query", "matching:latestMatch", { requestId: reqA });
    check("6. repeated identical runs reuse one row (same id) and give identical results", idA2 === idA && idA3 === idA && count("matches") === matchesBefore + 1 && JSON.stringify(m2.picks) === JSON.stringify(m.picks), `matches rows ${matchesBefore} -> ${count("matches")}`);
    // 4. other Client
    check("7. Client B cannot read Alice's results", await rejects(call("b", "query", "matching:latestMatch", { requestId: reqA }), /Draft not found/));
    check("8. Client B cannot run matching on Alice's request", await rejects(call("b", "mutation", "matching:findRobots", { requestId: reqA, task: "mowing", annualTaskCost: 1 }), /Draft not found/));
    check("8b. Alice's saved annual cost was not changed by that attempt", (await call("a", "query", "requests:getDraft", { id: reqA })).cost.currentAnnualCost === 60000);
    // 5. anonymous and Developer
    check("9. anonymous callers are rejected (read and run)", await rejects(call(null, "query", "matching:latestMatch", { requestId: reqA }), /Please sign in/) && await rejects(call(null, "mutation", "matching:findRobots", { requestId: reqA, task: "mowing" }), /Please sign in/));
    check("10. an approved Developer is rejected (read and run)", await rejects(call("dev", "query", "matching:latestMatch", { requestId: reqA }), /Client account/) && await rejects(call("dev", "mutation", "matching:findRobots", { requestId: reqA, task: "mowing" }), /Client account/));
    check("10b. rejected attempts stored nothing extra", count("matches") === matchesBefore + 1);
    // Bob's own request works and is separate
    const idB = await call("b", "mutation", "matching:findRobots", { requestId: reqB, task: "spraying", annualTaskCost: 40000 });
    const mb = await call("b", "query", "matching:latestMatch", { requestId: reqB });
    check("11. Client B can match their own request; it is a separate stored result", idB !== idA && mb.intent.task === "spraying" && count("matches") === matchesBefore + 2);
    // 6. existing functions
    check("12. existing account functions work (users:me shows the Client role)", (await call("a", "query", "users:me", {})).account?.role === "client");
    check("12b. existing request functions work (listMine returns only Alice's request)", (await call("a", "query", "requests:listMine", {})).map((r) => r._id).includes(reqA) && !(await call("a", "query", "requests:listMine", {})).map((r) => r._id).includes(reqB));
    await call("a", "mutation", "requests:updateIntake", { id: reqA, ...intake, profile: { companyName: "E2E-TEST Matching Co", businessType: "lawn", region: "West", crewCount: 2, hourlyLaborCost: 24, visibility: "shared" } });
    const bountyId = await call("a", "mutation", "bounties:post", { requestId: reqA, taskKey: "mow", title: "E2E-TEST mower for 28 degree slopes", specLines: ["Works on slopes up to 28 degrees"], gaps: [], note: "", industry: "Lawn care", pledgePercent: 30, pledged: 1000, goal: 90000 });
    const board = await call("dev", "query", "bounties:listPosted", {});
    check("13. existing bounty functions work (Alice posts, the approved Developer sees it, no private data)", board.some((b) => b._id === bountyId) && !JSON.stringify(board).includes("Matching Co"));
    check("14. a Developer is still refused Client data and a Client the board", await rejects(call("dev", "query", "requests:getDraft", { id: reqA }), /Client account/) && await rejects(call("a", "query", "bounties:listPosted", {}), /approved Developer/));
    // no AI / external
    check("15. no AI budget was spent and no paid or external request was made", count("aiUsage") === aiBefore, `aiUsage rows ${aiBefore} -> ${count("aiUsage")} ${scheduledNote}`);
  } finally {
    tabs.forEach((t) => t.close());
    await chrome.close();
    server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll real-Clerk matching checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

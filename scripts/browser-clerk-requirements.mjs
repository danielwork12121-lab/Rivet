// Real-Clerk checks of SAVED matching requirements (matching:saveRequirements / savedRequirements,
// findRobots with only a requestId) on the ISOLATED Convex Cloud deployment named in .env.local
// (the shared coordinated-canary-9 is refused). Real Clerk Development sessions (two Clients and a
// Developer; fictional +clerk_test users; windowed Chrome because of Clerk Protect). Fictional sample
// robots and deterministic maths only: no AI, Apify or scraping calls.
//
//   HEADED=1 node scripts/browser-clerk-requirements.mjs
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
    const rows = (table) => execFileSync("npx", ["convex", "data", table, "--limit", "1000", "--format", "jsonLines"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 }).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const fingerprint = () => Object.fromEntries(["users", "operatorRequests", "bounties", "matches", "robots"].flatMap((t) => rows(t).map((r) => [`${t}/${r._id}`, JSON.stringify(r)])));
    const before = fingerprint(); // every record that exists before this test
    const aiBefore = rows("aiUsage").length;

    const people = {};
    for (const [key, role, name] of [["a", "client", "Alice Req"], ["b", "client", "Bob Req"], ["dev", "developer", "Devi Req"]]) {
      const person = await newPerson(chrome.cdp);
      const tab = await person.tab(PRELOAD); tabs.push(tab);
      const r = await signUpVia(tab, base, { role, name, email: `rivet.e2e.r${key}.${RUN}+clerk_test@example.com` });
      check(`0${key}. real Clerk ${role} (${key}) signed up`, !!r.welcomed, r.error ?? "");
      if (!r.welcomed) throw new Error("sign-up failed; stopping");
      people[key] = { tab };
    }
    cli("users:setDeveloperStatus", { clerkUserId: await people.dev.tab.ev("Clerk.user.id"), status: "approved" });
    const tok = (k) => people[k].tab.ev("RivetAuth.getToken()");
    const call = async (k, kind, fn, args) => (k ? as(await tok(k)) : as(null))[kind](fn, args);
    const intake = { title: "E2E-TEST Requirements Co — Lawn care automation request", description: "Fictional: we mow steep lawns.", environment: "Lawn care operation, West region.", constraints: [] };
    const reqA = await call("a", "mutation", "requests:create", intake);
    const reqB = await call("b", "mutation", "requests:create", { ...intake, title: "E2E-TEST Bob's request" });
    const slope = (value, o = {}) => ({ name: "max_slope_deg", op: "atLeast", value, mandatory: true, ...o });
    const runtime = { name: "runtime_hours", op: "atLeast", value: 2, mandatory: false };
    const save = (k, requestId, o = {}) => call(k, "mutation", "matching:saveRequirements", { requestId, task: "mowing", requirements: [slope(25, { basis: "measured" }), runtime], annualTaskCost: 60000, ...o });
    const storedReq = (id) => rows("operatorRequests").find((r) => r._id === id);
    const storedMatches = (id) => rows("matches").filter((r) => r.requestId === id);

    // 1-2. save and read back; persisted in Convex
    const s1 = await save("a", reqA);
    check("1. Client saves matching requirements (no result exists yet, so none is created)", s1.changed === true && s1.matchUpdated === false && s1.matchId === null && storedMatches(reqA).length === 0);
    const got = await call("a", "query", "matching:savedRequirements", { requestId: reqA });
    check("2. Client retrieves the saved values (canonical order, default basis, annual cost)",
      got.task === "mowing" && got.annualTaskCost === 60000 && JSON.stringify(got.requirements.map((r) => [r.name, r.value, r.basis])) === JSON.stringify([["max_slope_deg", 25, "measured"], ["runtime_hours", 2, "estimate"]]));
    const stored = storedReq(reqA);
    check("2b. they are persisted on the request in Convex", stored.matchingInput?.task === "mowing" && stored.matchingInput.requirements.length === 2 && stored.cost?.currentAnnualCost === 60000);
    // 3. findRobots with only requestId
    const matchId = await call("a", "mutation", "matching:findRobots", { requestId: reqA });
    const m1 = await call("a", "query", "matching:latestMatch", { requestId: reqA });
    check("3. findRobots with ONLY requestId reuses the saved requirements", m1.status === "done" && m1.intent.task === "mowing" && m1.intent.annualTaskCost === 60000 && m1.intent.requirements.length === 2 && m1.picks.length === 3 && m1.stale === false);
    check("3b. requirement bases are reported: the Client's measured figure vs their estimate; robot data stays fictional",
      JSON.stringify(m1.requirementBases) === JSON.stringify(["measured", "estimate"]) && m1.picks.every((p) => p.dataSource === "fictional_sample" && p.fitSources.length === 2));
    // 4. idempotent
    const row1 = JSON.stringify(storedMatches(reqA));
    const upd1 = (await call("a", "query", "matching:savedRequirements", { requestId: reqA })).updatedAt;
    const s2 = await save("a", reqA, { requirements: [runtime, slope(25, { basis: "measured" })] }); // same set, other order
    const s3 = await save("a", reqA);
    check("4. identical saves are idempotent (reported unchanged, same updatedAt, stored result byte-identical)",
      !s2.changed && !s3.changed && !s2.matchUpdated && s2.matchId === matchId && (await call("a", "query", "matching:savedRequirements", { requestId: reqA })).updatedAt === upd1 && JSON.stringify(storedMatches(reqA)) === row1);
    // 5. changed requirements update the stored result
    const s4 = await save("a", reqA, { requirements: [slope(40, { basis: "measured" }), runtime] });
    const m2 = await call("a", "query", "matching:latestMatch", { requestId: reqA });
    const sm = storedMatches(reqA);
    check("5. changed requirements update the stored result in place (same row, new intent, not stale)",
      s4.changed && s4.matchUpdated && s4.matchId === matchId && sm.length === 1 && sm[0].intent.requirements.find((r) => r.name === "max_slope_deg").value === 40 && m2.stale === false && JSON.stringify(m2.picks.map((p) => p.robotId)) !== JSON.stringify(m1.picks.map((p) => p.robotId)));
    // 6. survive a legacy-style call
    await call("a", "mutation", "matching:findRobots", { requestId: reqA, task: "mowing", annualTaskCost: 70000 });
    const afterLegacy = await call("a", "query", "matching:savedRequirements", { requestId: reqA });
    check("6. saved requirements survive a later call that omits them (annual cost updated)", afterLegacy.requirements.find((r) => r.name === "max_slope_deg").value === 40 && afterLegacy.annualTaskCost === 70000);
    // 7. stale when the request changes elsewhere
    await call("a", "mutation", "requests:updateIntake", { id: reqA, ...intake, cost: { currency: "USD", currentAnnualCost: 90000, budget: 50000 } });
    const stale = (await call("a", "query", "matching:latestMatch", { requestId: reqA })).stale;
    await call("a", "mutation", "matching:findRobots", { requestId: reqA });
    const fresh = await call("a", "query", "matching:latestMatch", { requestId: reqA });
    check("7. a change made elsewhere marks the result stale until matching runs again", stale === true && fresh.stale === false && fresh.intent.annualTaskCost === 90000 && fresh.intent.budget === 50000);

    // 8. rejections, and nothing changed
    const snapA = JSON.stringify(storedReq(reqA)), snapM = JSON.stringify(storedMatches(reqA));
    const attempt = { requestId: reqA, task: "spraying", requirements: [], annualTaskCost: 1 };
    check("8a. Client B cannot save, read or run Alice's requirements",
      await rejects(call("b", "mutation", "matching:saveRequirements", attempt), /Draft not found/) && await rejects(call("b", "query", "matching:savedRequirements", { requestId: reqA }), /Draft not found/) && await rejects(call("b", "mutation", "matching:findRobots", { requestId: reqA, task: "spraying" }), /Draft not found/));
    check("8b. anonymous callers are rejected", await rejects(call(null, "mutation", "matching:saveRequirements", attempt), /Please sign in/) && await rejects(call(null, "query", "matching:savedRequirements", { requestId: reqA }), /Please sign in/));
    check("8c. an approved Developer is rejected", await rejects(call("dev", "mutation", "matching:saveRequirements", attempt), /Client account/) && await rejects(call("dev", "query", "matching:savedRequirements", { requestId: reqA }), /Client account/));
    check("8d. none of those attempts changed the request or its result", JSON.stringify(storedReq(reqA)) === snapA && JSON.stringify(storedMatches(reqA)) === snapM);
    // 9. invalid inputs
    const bad = [
      ["unknown requirement", { requirements: [slope(25, { name: "magic" })] }, /Unknown requirement/],
      ["negative value", { requirements: [slope(-5)] }, /non-negative/],
      ["duplicate requirement", { requirements: [slope(25), slope(30)] }, /Duplicate requirement/],
      ["blank task", { task: "  " }, /task must be 1-60/],
      ["zero annual cost", { annualTaskCost: 0 }, /annualTaskCost must be a positive/],
    ];
    let allRejected = true;
    for (const [, patch, re] of bad) allRejected = allRejected && await rejects(save("a", reqA, patch), re);
    check("9. invalid inputs are rejected and modify nothing (request and result byte-identical)", allRejected && JSON.stringify(storedReq(reqA)) === snapA && JSON.stringify(storedMatches(reqA)) === snapM);

    // 10. existing request (no saved input yet) still works the old way
    await call("b", "mutation", "requests:saveFollowUps", { id: reqB, complete: false, answers: [{ key: "slope", question: "Slopes?", answerLabel: "Some", assumption: { value: 20, unit: "degrees" } }] });
    check("10a. a request without saved requirements reports none saved", (await call("b", "query", "matching:savedRequirements", { requestId: reqB })) === null);
    await call("b", "mutation", "matching:findRobots", { requestId: reqB, task: "spraying", annualTaskCost: 40000 }); // old-style call
    const mb = await call("b", "query", "matching:latestMatch", { requestId: reqB });
    const sb = await call("b", "query", "matching:savedRequirements", { requestId: reqB });
    check("10b. an old-style findRobots call still works: slope answer derived, task saved, requirements stay 'derived'", mb.status === "done" && mb.requirementBases?.[0] === "derived_from_answers" && sb.requirements === null && sb.task === "spraying");
    // 10c-e. clearRequirements and overview (Phase 3C) on the deployed backend
    await call("b", "mutation", "matching:saveRequirements", { requestId: reqB, task: "spraying", requirements: [slope(35)] });
    const cleared = await call("b", "mutation", "matching:clearRequirements", { requestId: reqB });
    const ob = await call("b", "query", "matching:overview", { requestId: reqB });
    check("10c. clearRequirements restores the answer-derived requirement and refreshes the stored result",
      cleared.changed === true && ob.saved.requirements === null && ob.saved.task === "spraying" && ob.state === "current" && ob.match.requirementBases?.[0] === "derived_from_answers" && storedMatches(reqB).length === 1);
    const ovB = { requestId: reqB };
    check("10d. overview and clearRequirements: other Client, Developer and anonymous are rejected",
      await rejects(call("a", "query", "matching:overview", ovB), /Draft not found/) && await rejects(call("dev", "query", "matching:overview", ovB), /Client account/) &&
      await rejects(call(null, "query", "matching:overview", ovB), /Please sign in/) && await rejects(call("a", "mutation", "matching:clearRequirements", ovB), /Draft not found/));
    // 10e. the paid AI finder and web search are off on this deployment (AI_MATCH_ENABLED / DISCOVERY_ENABLED unset)
    const matchesBefore = rows("matches").length;
    check("10e. AI finder is off for the owner, and closed to Developers and anonymous callers; web search status needs a Client",
      await rejects(call("b", "mutation", "agent:findRobots", ovB), /turned off/) && (await call("b", "mutation", "agent:setTaskCost", { ...ovB, annualTaskCost: 40000 })) === null &&
      await rejects(call("dev", "mutation", "agent:findRobots", ovB), /Client account/) && await rejects(call(null, "mutation", "agent:findRobots", ovB), /Please sign in/) &&
      await rejects(call(null, "query", "discovery:forTask", { task: "spraying" }), /Please sign in/) && await rejects(call("dev", "query", "discovery:forTask", { task: "spraying" }), /Client account/) &&
      rows("matches").length === matchesBefore);
    // 11. existing functions
    check("11a. existing account and request functions work", (await call("a", "query", "users:me", {})).account?.role === "client" && (await call("a", "query", "requests:listMine", {})).some((r) => r._id === reqA));
    await call("a", "mutation", "requests:updateIntake", { id: reqA, ...intake, profile: { companyName: "E2E-TEST Requirements Co", businessType: "lawn", region: "West", crewCount: 2, hourlyLaborCost: 24, visibility: "shared" } });
    const bountyId = await call("a", "mutation", "bounties:post", { requestId: reqA, taskKey: "mow", title: "E2E-TEST mower for steep slopes", specLines: ["Works on steep slopes"], gaps: [], note: "", industry: "Lawn care", pledgePercent: 30, pledged: 1000, goal: 90000 });
    const board = await call("dev", "query", "bounties:listPosted", {});
    check("11b. existing bounty functions work (post, then the approved Developer sees it, no private data)", board.some((b) => b._id === bountyId) && !JSON.stringify(board).includes("Requirements Co"));
    // 12. existing records preserved
    const after = fingerprint();
    const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
    check("12. every record that existed before this test is byte-for-byte unchanged", changed.length === 0, changed.length ? `changed: ${changed.slice(0, 3).join(", ")}` : `${Object.keys(before).length} records compared`);
    check("13. no AI budget was spent and no paid or external request was made", rows("aiUsage").length === aiBefore, `aiUsage rows ${aiBefore} -> ${rows("aiUsage").length}`);
  } finally {
    tabs.forEach((t) => t.close());
    await chrome.close();
    server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll real-Clerk requirements checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

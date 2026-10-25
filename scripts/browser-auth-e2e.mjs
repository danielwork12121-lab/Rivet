// Real-browser checks for sign-up, sign-in, roles and the live bounty board, against
// a LOCAL Convex backend with real JWT verification (see scripts/e2e-auth-local.mjs
// for the setup: local issuer + `npx convex dev` on a local deployment).
//
//   npm run e2e:auth:browser
//
// Clerk itself is replaced by a scripted stand-in (scripts/fake-clerk.mjs) that implements
// the clerk-js calls js/rivet-auth.js makes; its session tokens come from the local
// issuer, so Convex really verifies them. This proves the pages, our auth wiring and
// Convex's checks. It does NOT prove real Clerk sign-up, email delivery or sessions.
// /api/chat is served by the real handler with Claude's endpoint stubbed: no paid calls.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import chatHandler from "../api/chat.js";
import { ConvexHttpClient } from "convex/browser";
import { fakeClerkScript, mintToken } from "./fake-clerk.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ISSUER = "http://127.0.0.1:8790";
const SECRET = process.env.RIVET_TEST_SERVER_SECRET || "local-test-secret-not-real";
let env = "";
try { env = readFileSync(join(ROOT, ".env.local"), "utf8"); } catch { /* none */ }
const CONVEX_URL = env.match(/^CONVEX_URL=(\S+)/m)?.[1];
if (CONVEX_URL !== "http://127.0.0.1:3210" || !/^CONVEX_DEPLOYMENT=(anonymous|local):/m.test(env)) {
  // The pages pick 127.0.0.1:3210 for "local" (js/rivet-config.js), so the CLI must match.
  console.error(`Refusing: .env.local must point at the local deployment on 127.0.0.1:3210 (found ${CONVEX_URL}).`);
  process.exit(2);
}
const RUN = Date.now().toString(36);

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

// ---- /api/chat: real handler, real Convex, stubbed Claude ---------------------------------
Object.assign(process.env, { CHAT_ENABLED: "true", ANTHROPIC_API_KEY: "test-key-not-real", CONVEX_URL, RIVET_SERVER_SECRET: SECRET });
const realFetch = globalThis.fetch;
const chatLog = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.anthropic.com/")) {
    chatLog.push("claude");
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Stubbed reply: got your mowing job." }], stop_reason: "end_turn" }), { status: 200 });
  }
  return realFetch(url, init);
};

function startServer() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path === "/api/chat") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader: (k, v) => res.setHeader(k, v),
        json(b) { chatLog.push(`chat ${this.statusCode}`); res.writeHead(this.statusCode, { "content-type": "application/json" }).end(JSON.stringify(b)); return this; } };
      await chatHandler({ method: req.method, headers: { ...req.headers, "x-vercel-forwarded-for": "198.51.100.77" }, body: raw }, out);
      return;
    }
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ---- Chrome over the DevTools protocol (same approach as scripts/browser-e2e.mjs) ------------
function findChrome() {
  const found = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "rivet-auth-e2e-"));
  const proc = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
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
      const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
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

// ---- the stand-in for clerk-js (see scripts/fake-clerk.mjs) ------------------------------------
const FAKE_CLERK = fakeClerkScript(ISSUER);

// ---- page helpers --------------------------------------------------------------------------
const text = (sel = "body") => `(document.querySelector(${JSON.stringify(sel)})?.innerText || "")`;
const has = (t, sel = "body") => `${text(sel)}.includes(${JSON.stringify(t)})`;
const pathIs = (p) => `location.pathname.endsWith(${JSON.stringify(p)})`;
const buttonWith = (t) => `[...document.querySelectorAll("button")].find((b) => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(t)}))`;
const clickButton = (t) => `(${buttonWith(t)}).click()`;

async function signUpVia(tab, base, { role, name, email, password, wrongCodeFirst = false }) {
  await tab.go(`${base}/pages/signup.html`);
  await tab.waitFor(has("How will you use Rivet?"));
  await tab.ev(`document.querySelectorAll('[role=radio]')[${role === "developer" ? 1 : 0}].click()`);
  await tab.typeInto("input[autocomplete=name]", name);
  await tab.typeInto("input[autocomplete=organization]", "E2E-TEST Org " + RUN);
  await tab.typeInto("input[autocomplete=email]", email);
  await tab.typeInto("input[autocomplete=new-password]", password);
  await tab.mouseClick("input[type=checkbox]");
  await tab.ev(clickButton("Create account"));
  const verify = await tab.waitFor(has("We emailed a verification code"));
  let wrongShown = true;
  if (wrongCodeFirst) {
    await tab.typeInto("input[autocomplete=one-time-code]", "000000");
    await tab.ev(`document.getElementById("signup-verify-btn").click()`);
    wrongShown = await tab.waitFor(has("That code isn't right"));
  }
  await tab.typeInto("input[autocomplete=one-time-code]", "424242");
  await tab.ev(`document.getElementById("signup-verify-btn").click()`);
  const welcomed = await tab.waitFor(has("Your account is ready"));
  return { verify, wrongShown, welcomed };
}

async function main() {
  try { await realFetch(`${CONVEX_URL}/version`); } catch { console.error("Local Convex backend is not running (npx convex dev)."); process.exit(2); }
  try { await realFetch(`${ISSUER}/.well-known/jwks.json`); } catch { console.error("Local test issuer is not running (node scripts/local-auth-issuer.mjs)."); process.exit(2); }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome();
  const tabs = [];
  try {
    const clientEmail = `e2e-client-${RUN}@example.test`, devEmail = `e2e-dev-${RUN}@example.test`;
    const client = await newPerson(chrome.cdp), dev = await newPerson(chrome.cdp), visitor = await newPerson(chrome.cdp);

    // ---- signed out ------------------------------------------------------------------------
    const v = await visitor.tab(FAKE_CLERK); tabs.push(v);
    await v.go(`${base}/pages/robot-bounty-client-flow.html`);
    check("signed out: the client flow sends you to log in", await v.waitFor(`${pathIs("/login.html")} && location.search.includes("reason=signin")`));
    check("…and the login page says why", await v.waitFor(has("Please log in to continue.")));
    await v.go(`${base}/pages/engineers.html`);
    check("signed out: the engineers board shows samples and asks for a Developer login", await v.waitFor(has("Log in with an approved Developer account")));
    await v.go(`${base}/pages/index.html`);
    await v.waitFor(`document.querySelector("textarea, input[type=text]")`);
    const before = chatLog.length;
    const chatInput = await v.ev(`(() => { const el = [...document.querySelectorAll("textarea, input")].find((e) => e.getAttribute("data-enter-submit")); return el ? (el.id ? "#" + el.id : el.tagName.toLowerCase() + "[data-enter-submit]") : null; })()`);
    if (chatInput) {
      await v.typeInto(chatInput, "We mow 40 fictional lawns a week.");
      await v.pressEnter();
      check("signed out: the chat asks you to log in and never calls /api/chat", await v.waitFor(has("Log in with a Client account to chat")) && chatLog.length === before);
    } else check("signed out: chat input found on index.html", false);

    // ---- Client registration with email verification ---------------------------------------
    const c = await client.tab(FAKE_CLERK); tabs.push(c);
    const su = await signUpVia(c, base, { role: "client", name: "Casey E2E", email: clientEmail, password: "pw-e2e-12345", wrongCodeFirst: true });
    check("Client sign-up asks for the emailed code", su.verify);
    check("a wrong code is refused with a clear message", su.wrongShown);
    check("the right code creates the account and welcomes the Client", su.welcomed);
    const clientSub = await c.ev("__e2eSub()");
    const listed = cli("users:list", { role: "client" }).find((u) => u.clerkUserId === clientSub);
    check("Convex recorded the Client role for that verified identity", listed?.role === "client" && listed?.organization === "E2E-TEST Org " + RUN);

    // ---- login page: signed in, sign out, wrong password, sign back in ------------------------
    await c.go(`${base}/pages/login.html`);
    check("login page shows the signed-in account and the Client destination", await c.waitFor(has("You’re logged in as") + " && " + has("Go to your requests")));
    await c.ev(clickButton("Sign out"));
    check("sign out returns to the login form", await c.waitFor(has("Welcome back") + ` && !!document.querySelector("#login-submit-btn")`));
    await c.typeInto("input[type=email]", clientEmail);
    await c.typeInto("input[type=password]", "wrong-password");
    await c.ev(`document.getElementById("login-submit-btn").click()`);
    check("a wrong password is refused", await c.waitFor(has("That email and password don't match an account.")));
    await c.typeInto("input[type=password]", "pw-e2e-12345");
    await c.pressEnter();
    check("signing in sends a Client to Find a solution", await c.waitFor(`${pathIs("/find-solution.html")} && typeof RivetApi === "object"`, 20000));
    await c.go(`${base}/pages/robot-bounty-client-flow.html`); // the Client checks below run on the client-flow page
    await c.waitFor(`typeof S === "object" && S.gate === "ready"`, 45000);

    // ---- Client experience ----------------------------------------------------------------
    check("the Client sees only the Client view", await c.ev(`document.querySelector('#role [data-role=dev]').hidden && !document.querySelector('#role [data-role=client]').hidden && S.role === "client"`));
    check("header names the signed-in Client account", await c.ev(has(clientEmail, "#acct") + " && " + has("(Client)", "#acct")));
    const company = `E2E-TEST Browser Co ${RUN}`;
    await c.ev(`(() => { const e = document.querySelector("#f-name"); e.value = ${JSON.stringify(company)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await c.ev(`S.name = ${JSON.stringify(company)}`);
    await c.ev(`document.querySelector("#next").click()`);
    check("Client saves a request (step 1)", await c.waitFor(`S.step === 1 && !!S.submit.id`, 20000));
    const requestId = await c.ev("S.submit.id");
    const owner = cli("requests:get", { id: requestId })?.ownerId;
    const clientUserRow = execFileSync("npx", ["convex", "data", "users", "--format", "jsonLines", "--limit", "10000"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((u) => u.clerkUserId === clientSub);
    check("the saved request is owned by the signed-in Client account", !!owner && owner === clientUserRow?._id);
    await c.ev(`(() => { S.answered = QUESTIONS.length; render(); })()`); // the page's default picks, as answered
    await c.ev(`document.querySelector("#next").click()`);
    check("Client saves follow-up answers (step 2)", await c.waitFor(`S.step === 2 && S.answersSave.status === "saved"`, 20000));
    await c.ev(`startBounty("mow", null); render();`);
    await c.waitFor(`!!document.querySelector("#post")`);

    // ---- Developer registration: pending, then approved ----------------------------------------
    const d = await dev.tab(FAKE_CLERK); tabs.push(d);
    const dsu = await signUpVia(d, base, { role: "developer", name: "Devi E2E", email: devEmail, password: "pw-e2e-67890" });
    check("Developer sign-up completes and says approval is pending", dsu.welcomed && await d.waitFor(has("waiting for approval by Rivet")));
    await d.go(`${base}/pages/engineers.html`);
    check("a pending Developer sees samples and a pending notice", await d.waitFor(has("waiting for approval, so only sample bounties")));
    await d.go(`${base}/pages/robot-bounty-client-flow.html`);
    check("a pending Developer gets the Developer view only", await d.waitFor(`typeof S === "object" && S.gate === "ready" && S.role === "dev"`) && await d.ev(`document.querySelector('#role [data-role=client]').hidden`));
    const devSub = await d.ev("__e2eSub()");
    cli("users:setDeveloperStatus", { clerkUserId: devSub, status: "approved" });

    // ---- live board -----------------------------------------------------------------------------
    await d.go(`${base}/pages/engineers.html`);
    check("an approved Developer's board loads live data", await d.waitFor(has("No Client has posted a bounty yet") + " || " + has("posted on Rivet"), 20000));
    const title = await c.ev("bountyTitle()");
    const t0 = Date.now();
    await c.ev(`document.querySelector("#post").click()`);
    check("Client posts the bounty", await c.waitFor(`S.bountySave.status === "saved"`, 20000));
    check("the posted bounty appears on the open Developer board without a reload", await d.waitFor(has(title) + " && " + has("posted on Rivet"), 15000), `(${Date.now() - t0} ms)`);
    check("the board never shows the Client's company name", !(await d.ev(has(company))));
    await d.go(`${base}/pages/robot-bounty-client-flow.html`);
    await d.waitFor(`S.gate === "ready"`);
    await d.ev(`goDev(1)`);
    check("the Developer view of the client-flow page lists it too, live", await d.waitFor(has(title) + " && " + has("posted by Client accounts"), 15000));

    // ---- markup, anonymity and sign-out on the engineers board -------------------------------------
    const asClientApi = new ConvexHttpClient(CONVEX_URL);
    asClientApi.setAuth(await mintToken(ISSUER, clientSub, clientEmail));
    const markupTitle = `<img src=x onerror="window.__xss=1"> E2E-TEST markup ${RUN}`;
    const shared = { title: `E2E-TEST markup ${RUN}`, description: "Fictional.", environment: "Lawn care operation.", constraints: [],
      profile: { companyName: `E2E-TEST Markup Co ${RUN}`, businessType: "lawn", region: "South", crewCount: 1, hourlyLaborCost: 20, visibility: "shared" } };
    const markupReq = await asClientApi.mutation("requests:create", shared);
    await d.go(`${base}/pages/engineers.html`);
    await d.waitFor(has(title));
    await asClientApi.mutation("bounties:post", { requestId: markupReq, taskKey: "spray", title: markupTitle, specLines: ["<b>bold?</b> spec line"],
      gaps: [], note: "", industry: "Lawn care", pledgePercent: 30, pledged: 1000, goal: 90000 });
    check("live bounty markup shows as text on the engineers board and never runs",
      await d.waitFor(has(markupTitle), 15000) && await d.ev(`window.__xss === undefined && ![...document.querySelectorAll("main img, section img")].some((i) => i.getAttribute("src") === "x")`));
    await asClientApi.mutation("requests:updateIntake", { id: markupReq, ...shared, profile: { ...shared.profile, visibility: "anonymous" } });
    check("switching that request to anonymous takes its bounty off the open board", await d.waitFor(`!${has(markupTitle)}`, 15000));
    await d.ev(`__e2eExpire()`);
    // (The posted title matches a sample card's, so look for the live label instead.)
    check("signing out stops the engineers board and drops live bounties", await d.waitFor(has("Log in with an approved Developer account") + ` && !${has("posted on Rivet")}`, 15000));
    // Sign the Developer back in for the checks below (same account, new session).
    await d.ev(`(() => { const u = JSON.parse(localStorage.getItem("e2e.clerk.users"))[${JSON.stringify(devEmail)}]; localStorage.setItem("e2e.clerk.session", JSON.stringify({ sid: "sess_again", sub: u.sub, email: ${JSON.stringify(devEmail)} })); })()`);

    // ---- wrong-role access -----------------------------------------------------------------------
    await c.go(`${base}/pages/engineers.html`);
    check("a Client on the engineers page gets samples only, with an explanation", await c.waitFor(has("You’re signed in with a Client account")) && !(await c.ev(has("posted on Rivet"))));

    // ---- chat with a session ---------------------------------------------------------------------
    await c.go(`${base}/pages/index.html`);
    await c.waitFor(`!!document.querySelector("[data-enter-submit]")`);
    const sel = await c.ev(`(() => { const el = [...document.querySelectorAll("textarea, input")].find((e) => e.getAttribute("data-enter-submit")); return el.id ? "#" + el.id : el.tagName.toLowerCase() + "[data-enter-submit]"; })()`);
    const n0 = chatLog.length;
    await c.typeInto(sel, "We mow 40 fictional lawns a week.");
    await c.pressEnter();
    check("a signed-in Client's chat reaches /api/chat, Convex verifies the token, and the reply shows", await c.waitFor(has("Stubbed reply: got your mowing job."), 20000) && chatLog.slice(n0).join(",") === "claude,chat 200");
    await d.go(`${base}/pages/index.html`);
    await d.waitFor(`!!document.querySelector("[data-enter-submit]")`);
    const n1 = chatLog.length;
    await d.typeInto(sel, "We build robots.");
    await d.pressEnter();
    check("a Developer's chat is refused by the server (403) without calling Claude", await d.waitFor(has("The AI assistant is for Client accounts."), 20000) && chatLog.slice(n1).join(",") === "chat 403");

    // ---- new-device code, password reset ------------------------------------------------------------
    await c.go(`${base}/pages/login.html`);
    await c.waitFor(has("Go to your requests"));
    await c.ev(clickButton("Sign out"));
    await c.waitFor(`!!document.querySelector("#login-submit-btn")`);
    await c.ev(`__e2eMarkNewDevice(${JSON.stringify(clientEmail)})`);
    await c.typeInto("input[type=email]", clientEmail);
    await c.typeInto("input[type=password]", "pw-e2e-12345");
    await c.ev(`document.getElementById("login-submit-btn").click()`);
    check("sign-in from a new device asks for the emailed code", await c.waitFor(has("We emailed a sign-in code")));
    await c.typeInto("input[autocomplete=one-time-code]", "424242");
    await c.ev(`document.getElementById("login-code-btn").click()`);
    check("the code completes sign-in and routes to Find a solution", await c.waitFor(`${pathIs("/find-solution.html")} && typeof RivetApi === "object"`, 20000));
    await c.go(`${base}/pages/robot-bounty-client-flow.html`); // the Client checks below run on the client-flow page
    await c.waitFor(`typeof S === "object" && S.gate === "ready"`, 45000);
    check("the saved request is restored after signing in again", await c.waitFor(`S.submit.id === ${JSON.stringify(requestId)} && S.name === ${JSON.stringify(company)}`, 15000));
    await c.ev(`signOut()`);
    check("signing out from the client page lands on the login page", await c.waitFor(`${pathIs("/login.html")} && ${has("You’ve been signed out.")}`));
    await c.ev(`(${`[...document.querySelectorAll("a")].find((a) => a.textContent.includes("Forgot password?"))`}).click()`);
    await c.waitFor(has("We’ll send a code to set a new password"));
    await c.typeInto("input[type=email]", clientEmail);
    await c.ev(`document.getElementById("login-reset-btn").click()`);
    check("password reset sends a code", await c.waitFor(has("we emailed it a code")));
    await c.typeInto("input[autocomplete=one-time-code]", "424242");
    await c.typeInto("input[autocomplete=new-password]", "short");
    await c.ev(`document.getElementById("login-newpw-btn").click()`);
    check("a too-short new password is refused before calling Clerk", await c.waitFor(has("at least 8 characters")));
    await c.typeInto("input[autocomplete=new-password]", "pw-e2e-new-123");
    await c.ev(`document.getElementById("login-newpw-btn").click()`);
    check("reset + new password signs in and routes to Find a solution", await c.waitFor(`${pathIs("/find-solution.html")} && typeof RivetApi === "object"`, 20000));
    await c.go(`${base}/pages/robot-bounty-client-flow.html`); // the Client checks below run on the client-flow page
    await c.waitFor(`typeof S === "object" && S.gate === "ready"`, 45000);

    // ---- session ends while the page is open ---------------------------------------------------------
    await c.ev(`__e2eExpire()`);
    check("an ended session sends the open page back to login with a reason", await c.waitFor(`${pathIs("/login.html")} && ${has("Your session ended. Please log in again.")}`));

    const errs = tabs.flatMap((t) => t.errors).filter((e) => !/favicon/i.test(e));
    check("no uncaught page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  } finally {
    tabs.forEach((t) => t.close());
    await chrome.close();
    server.close();
    globalThis.fetch = realFetch;
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll browser auth checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Real-Clerk authorization checks for the Gemini video endpoint (api/analyze-video.js).
// Real Clerk Development sessions (a Client and a Developer, fictional +clerk_test users,
// windowed Chrome because Clerk Protect) call the REAL handler in-process, which asks the
// ISOLATED Convex Cloud deployment named in .env.local (aiBudget:reserveVideo) to verify the
// token and reserve budget. Only Gemini is stubbed: no paid calls. Sets RIVET_SERVER_SECRET
// on that deployment to a fresh random value (never printed or stored).
//
//   HEADED=1 node scripts/browser-clerk-video.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import handler from "../api/analyze-video.js";

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
  const realFetch = globalThis.fetch;
  try {
    // A fresh random secret on the isolated deployment only (not printed, not stored).
    const SECRET = randomBytes(24).toString("hex");
    execFileSync("npx", ["convex", "env", "set", "RIVET_SERVER_SECRET", SECRET], { cwd: ROOT, stdio: "ignore", timeout: 90_000 });
    Object.assign(process.env, { VIDEO_ENABLED: "true", GEMINI_API_KEY: "gemini-key-not-real", CONVEX_URL, RIVET_SERVER_SECRET: SECRET });

    // Gemini is stubbed; everything else (Convex Cloud) is real.
    let geminiCalls = 0;
    const ANALYSIS = { taskSummary: "Mowing a fictional lawn.", environment: [], observedObjects: [], obstacles: [], repetitiveActions: [], requirements: [], followUpQuestions: [], robotCapabilitiesNeeded: [], frames: [] };
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
        geminiCalls++;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANALYSIS) }] } }] }), { status: 200 });
      }
      return realFetch(url, init);
    };
    const FRAME = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD";
    const callVideo = async (token, body = { frames: [FRAME, FRAME] }) => {
      const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
      await handler({ method: "POST", headers: { "x-vercel-forwarded-for": "198.51.100.44", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }, res);
      return res;
    };
    const videoRows = () => execFileSync("npx", ["convex", "data", "aiUsage", "--limit", "1000", "--format", "jsonLines"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 90_000 })
      .split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((r) => r.kind === "video").length;

    check("0. aiBudget:reserveVideo is deployed (wrong secret -> forbidden, not 'function not found')",
      await rejects(new (await import("convex/browser")).ConvexHttpClient(CONVEX_URL).mutation("aiBudget:reserveVideo", { secret: "wrong", clientKey: "a".repeat(32) }), /forbidden/));

    // Real Clerk sessions (tabs stay open: Clerk tokens last 60 s, so fetch a fresh one per call)
    const client = await newPerson(chrome.cdp), dev = await newPerson(chrome.cdp);
    const c = await client.tab(PRELOAD); tabs.push(c);
    const su = await signUpVia(c, base, { role: "client", name: "Casey Video", email: `rivet.e2e.vclient.${RUN}+clerk_test@example.com` });
    check("1. real Clerk Client signed up", !!su.welcomed, su.error ?? "");
    const d = await dev.tab(PRELOAD); tabs.push(d);
    const dsu = await signUpVia(d, base, { role: "developer", name: "Devi Video", email: `rivet.e2e.vdev.${RUN}+clerk_test@example.com` });
    check("2. real Clerk Developer signed up", !!dsu.welcomed, dsu.error ?? "");
    if (!su.welcomed || !dsu.welcomed) throw new Error("sign-up failed; stopping");
    cli("users:setDeveloperStatus", { clerkUserId: await d.ev("Clerk.user.id"), status: "approved" });
    const tok = (tab) => tab.ev("RivetAuth.getToken()");

    const before = videoRows();
    // Anonymous / tampered
    let r = await callVideo(null);
    check("3. anonymous caller: 401, nothing reserved, no Gemini call", r.statusCode === 401 && videoRows() === before && geminiCalls === 0, `HTTP ${r.statusCode}`);
    const [h, p, sig] = (await tok(c)).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), sub: "user_someone_else" })).toString("base64url");
    r = await callVideo(`${h}.${forged}.${sig}`);
    check("4. tampered real token: 401 from Convex, no Gemini call", r.statusCode === 401 && geminiCalls === 0, `HTTP ${r.statusCode}`);
    // Developer (approved)
    r = await callVideo(await tok(d));
    check("5. approved Developer: 403, nothing reserved, no Gemini call", r.statusCode === 403 && videoRows() === before && geminiCalls === 0, `HTTP ${r.statusCode} ${r.body?.error}`);
    // Disabled
    process.env.VIDEO_ENABLED = "";
    r = await callVideo(await tok(c));
    check("6. video disabled: 503 even for a valid Client, nothing reserved, no Gemini call", r.statusCode === 503 && videoRows() === before && geminiCalls === 0, `HTTP ${r.statusCode}`);
    process.env.VIDEO_ENABLED = "true";
    // Malformed: rejected before budget
    r = await callVideo(await tok(c), { frames: ["data:text/html;base64,PGgxPg=="] });
    check("7. malformed frame from a valid Client: 400, nothing reserved, no Gemini call", r.statusCode === 400 && videoRows() === before && geminiCalls === 0, `HTTP ${r.statusCode}`);
    // Accepted within budget (default 3 per account per day)
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await callVideo(await tok(c))).statusCode);
    check("8. authenticated Client accepted within budget (3 of 3), mocked Gemini analysis returned", codes.join() === "200,200,200" && geminiCalls === 3 && videoRows() === before + 3, `HTTP ${codes.join(",")}`);
    // Over the limit
    r = await callVideo(await tok(c));
    check("9. 4th request exceeds the per-account daily limit: 429, no extra reservation, no Gemini call", r.statusCode === 429 && geminiCalls === 3 && videoRows() === before + 3, `HTTP ${r.statusCode} ${r.body?.error}`);
    check("10. no real Gemini or Anthropic request was made (only the 3 stubbed analyses)", geminiCalls === 3);
  } finally {
    globalThis.fetch = realFetch;
    tabs.forEach((t) => t.close());
    await chrome.close();
    server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll video authorization checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

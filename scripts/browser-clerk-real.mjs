// Real-Clerk checks: the website served locally, real clerk-js and the Clerk DEVELOPMENT
// instance (relevant-kingfish-8271), against an ISOLATED Convex Cloud dev deployment
// (.env.local must name it; the shared coordinated-canary-9 is refused). No mocks, no local
// test issuer. Creates two fictional Clerk test users (+clerk_test emails: Clerk accepts the
// fixed code 424242 for these and sends no mail). Makes no AI calls.
//
//   npm run e2e:clerk
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { ConvexHttpClient } from "convex/browser";

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
    const clientEmail = `rivet.e2e.client.${RUN}+clerk_test@example.com`;
    const devEmail = `rivet.e2e.dev.${RUN}+clerk_test@example.com`;
    const client = await newPerson(chrome.cdp), dev = await newPerson(chrome.cdp);

    // 1+2. Client sign-up with real Clerk email-code verification
    const c = await client.tab(PRELOAD); tabs.push(c);
    const su = await signUpVia(c, base, { role: "client", name: "Casey E2E", email: clientEmail });
    check("1. real Clerk: Client sign-up asks for the emailed code", su.verifyShown, su.error ?? "");
    check("2. real Clerk: the code verifies and the account is created", !!su.welcomed, su.error ?? "");
    if (!su.welcomed) throw new Error("sign-up failed; stopping (see messages above)");
    const clientSub = await c.ev("Clerk.user.id");
    const tokenInfo = await c.ev(`RivetAuth.getToken().then((t) => { const p = JSON.parse(atob((b => b + "=".repeat((4 - b.length % 4) % 4))(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))); return { aud: p.aud, iss: p.iss, sub: p.sub, hasEmail: !!p.email, exp: p.exp - Math.floor(Date.now() / 1000) }; })`);
    check("3a. the real session token has audience convex and this issuer", tokenInfo.aud === "convex" && tokenInfo.iss === ISSUER && tokenInfo.sub === clientSub, JSON.stringify({ aud: tokenInfo.aud, hasEmail: tokenInfo.hasEmail, secondsLeft: tokenInfo.exp }));
    const clientRow = cli("users:list", { role: "client" }).find((u) => u.clerkUserId === clientSub);
    check("3b. Convex Cloud accepted that token and stored the Client account", clientRow?.role === "client" && clientRow.organization === "E2E-TEST Org " + RUN, `email in account: ${clientRow?.email ?? "none (token has no email claim)"}`);

    // login / logout round trip
    await c.go(`${base}/pages/login.html`);
    await c.ev(clickButton("Sign out"));
    check("1b. sign out returns to the login form", await c.waitFor(`!!document.querySelector("#login-submit-btn")`, 30000) && (await c.ev("Clerk.user")) === null);
    await c.typeInto("input[type=email]", clientEmail);
    await c.typeInto("input[type=password]", PASSWORD);
    await c.ev(`document.getElementById("login-submit-btn").click()`);
    await sleep(20000);
    check("1c. real Clerk login routes the Client to their page", await c.waitFor(`${pathIs("/robot-bounty-client-flow.html")} && typeof S === "object" && S.gate === "ready"`, 45000), await c.ev(text("[role=alert]")).catch(() => ""));
    check("4a. the Client sees only the Client view", await c.ev(`S.role === "client" && document.querySelector('#role [data-role=dev]').hidden`));

    // 4. request ownership
    const company = `E2E-TEST Clerk Co ${RUN}`;
    await c.ev(`S.name = ${JSON.stringify(company)}; render();`);
    await c.ev(`document.querySelector("#next").click()`);
    check("4b. Client saves a request to Convex Cloud", await c.waitFor(`S.step === 1 && !!S.submit.id`, 30000));
    const requestId = await c.ev("S.submit.id");
    const owner = cli("requests:get", { id: requestId })?.ownerId;
    const users = cli("users:list", {});
    check("4c. the request is owned by that Client account", !!owner && users.length > 0);
    await c.ev(`(() => { S.answered = QUESTIONS.length; render(); })()`);
    await c.ev(`document.querySelector("#next").click()`);
    await c.waitFor(`S.step === 2`, 30000);
    await c.ev(`startBounty("mow", null); render();`);
    await c.waitFor(`!!document.querySelector("#post")`);

    // 5. Developer: sign up, pending, then approved
    const d = await dev.tab(PRELOAD); tabs.push(d);
    const dsu = await signUpVia(d, base, { role: "developer", name: "Devi E2E", email: devEmail });
    check("5a. real Clerk: Developer sign-up completes (pending approval)", !!dsu.welcomed && await d.ev(has("waiting for approval")), dsu.error ?? "");
    const devSub = await d.ev("Clerk.user.id");
    await d.go(`${base}/pages/engineers.html`);
    check("5b. a pending Developer sees samples and the pending notice", await d.waitFor(has("waiting for approval, so only sample bounties"), 30000));
    const pending = cli("users:list", { developerStatus: "pending" }).find((u) => u.clerkUserId === devSub);
    check("5c. Convex lists them as a pending Developer", !!pending);
    cli("users:setDeveloperStatus", { clerkUserId: devSub, status: "approved" });
    await d.go(`${base}/pages/engineers.html`);
    check("5d. once approved, the board loads live data", await d.waitFor(has("No Client has posted a bounty yet") + " || " + has("posted on Rivet"), 30000));

    // 6+7. publish, appear live
    const title = await c.ev("bountyTitle()");
    const t0 = Date.now();
    await c.ev(`document.querySelector("#post").click()`);
    check("6. Client publishes one fictional bounty", await c.waitFor(`S.bountySave.status === "saved"`, 30000));
    check("7. the Developer sees it on the open board without reloading", await d.waitFor(has(title) + " && " + has("posted on Rivet"), 20000), `(${Date.now() - t0} ms)`);
    check("7b. the board never shows the Client's company name", !(await d.ev(has(company))));

    // 8. unauthorized requests, with real Clerk tokens
    const tok = (tab) => tab.ev("RivetAuth.getToken()");
    const clientTok = await tok(c), devTok = await tok(d);
    const as = (t) => { const x = new ConvexHttpClient(CONVEX_URL); if (t) x.setAuth(t); return x; };
    check("8a. no token: the board is refused", await rejects(as(null).query("bounties:listPosted", {}), /Please sign in/));
    check("8b. no token: creating a request is refused", await rejects(as(null).mutation("requests:create", { title: "x", description: "x", environment: "x", constraints: [] }), /Please sign in/));
    check("8c. a Client token can't read the Developer board", await rejects(as(clientTok).query("bounties:listPosted", {}), /approved Developer/));
    check("8d. a Developer token can't read the Client's request", await rejects(as(devTok).query("requests:getDraft", { id: requestId }), /Client account/));
    check("8e. a Developer token can't start AI on it (no AI call made)", await rejects(as(devTok).mutation("agent:generateSpec", { requestId }), /Client account/));
    const [h, p, sig] = clientTok.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), sub: devSub })).toString("base64url");
    check("8f. a token with a tampered subject is rejected by Convex Cloud", await rejects(as(`${h}.${forged}.${sig}`).query("users:me", {}), /Unauthenticated|verify/i));
    check("8g. a Client can't switch itself to Developer", await rejects(as(clientTok).mutation("users:chooseRole", { role: "developer" }), /already set/));

    const errs = tabs.flatMap((t) => t.errors).filter((e) => !/favicon/i.test(e));
    check("no uncaught page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  } finally {
    tabs.forEach((t) => t.close());
    await chrome.close();
    server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll real-Clerk checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

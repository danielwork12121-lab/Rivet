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

// A fresh browser context has its own storage and cookies: effectively a different person.
async function newIsolatedTarget(cdp) {
  const { webSocketDebuggerUrl } = await (await fetch(`${cdp}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    ws.addEventListener("message", function on(m) { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", on); r(d.result); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const { browserContextId } = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  ws.close();
  return { id: targetId, webSocketDebuggerUrl: `${cdp.replace("http", "ws")}/devtools/page/${targetId}` };
}

async function openTab(cdp, pageUrl, preload, isolated = false) {
  const t = isolated ? await newIsolatedTarget(cdp) : await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
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
  // Real input events (focus, blur, mousedown/up order) rather than element.click().
  const mouseClick = async (selector) => {
    const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, vh: innerHeight }; })()`);
    if (box.y < 0 || box.y > box.vh) throw new Error(`${selector} is outside the viewport`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  const typeInto = async (selector, text) => {
    await mouseClick(selector);
    await send("Input.insertText", { text });
  };
  return {
    ev, waitFor, errors, reload: load, mouseClick, typeInto,
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

function bountiesFor(requestId) {
  const out = execFileSync("npx", ["convex", "data", "bounties", "--limit", "10000", "--format", "jsonLines"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((b) => b.requestId === requestId);
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
const clearToast = `document.querySelector("#toast").textContent = ""`;
const toastSaysSaved = `/saved/i.test(document.querySelector("#toast").textContent)`;
// Make every Convex call from the page fail as if the network dropped.
const breakNetwork = `RivetApi._setClient({ mutation: () => Promise.reject(new TypeError("Failed to fetch")), query: () => Promise.reject(new TypeError("Failed to fetch")) })`;
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
  const open = async (preload, isolated) => { const t = await openTab(chrome.cdp, pageUrl, preload, isolated); tabs.push(t); return t; };
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
    for (let i = 0; i < 3; i++) { // first option each time: "Very few", "Mostly open", "About 26"
      await tab.ev(`document.querySelector('.chip[data-q="${i}"]').click()`);
      await sleep(50);
    }
    check("answering all follow-ups enables the next button", await tab.ev(`!document.querySelector("#next").disabled`));
    await tab.ev(click("#next"));
    check("follow-ups -> opportunities after the answers are saved", await tab.waitFor(onStep(2)));
    let row = rowsFor(company)[0];
    check("all three answers stored on the same request, marked complete",
      row?.followUps?.length === 3 && row.followUpsComplete === true && rowsFor(company).length === 1,
      JSON.stringify(row?.followUps?.map((a) => a.answerLabel)));
    check("stored answers keep raw label, stable key and illustrative assumption apart",
      row?.followUps?.[0]?.key === "slope" && row.followUps[0].answerLabel === "Very few" &&
      row.followUps[0].assumption?.unit === "degrees" && !("unit" in (row.followUps[1].assumption ?? {})));
    await tab.ev(click("[data-bounty]"));
    check("opportunities -> request a bounty", await tab.waitFor(`${onStep(4)} && !!document.querySelector("#post")`));
    const note = `Fits in the trailer <img src=x onerror="window.__xss=1"> & more ${RUN}`;
    const draftId = JSON.parse(await tab.ev(`localStorage.getItem("rivet.intake.draft")`)).id;
    const bountyTitleText = await tab.ev("bountyTitle()");
    await tab.ev(clearToast);
    // Like a person: type the note, then go straight for the Post button with the mouse
    // (the field blurs on mousedown). Then press it again while it saves.
    await tab.typeInto("#gap-note", note);
    await tab.mouseClick("#post"); // exactly one click
    check("typing a note then clicking Post posts on the first click",
      await tab.waitFor(`S.posted && S.bountySave.status === "saved" && !!document.querySelector("#restart") && /Bounty posted/.test(document.querySelector("#toast").textContent)`));
    await tab.ev(`document.querySelector("#post")?.click(); document.querySelector("#post")?.click();`); // late extra clicks
    await sleep(500);
    let bRows = bountiesFor(draftId);
    check("two clicks stored exactly one posted bounty", bRows.length === 1 && bRows[0].status === "posted" && bRows[0].source === "client", `rows=${bRows.length}`);
    check("the note is stored raw, exactly as typed", bRows[0]?.note === note && bRows[0].specLines.at(-1) === note);
    check("the posted page shows the note as text, not HTML",
      await tab.ev(`window.__xss === undefined && !document.querySelector("#app .spec img") && document.querySelector("#app .spec").textContent.includes("<img src=x")`));
    for (const n of [0, 1, 2, 3, 4]) {
      await tab.ev(stepper(n));
      check(`client stepper opens step ${n + 1}`, await tab.waitFor(onStep(n)));
    }
    check("revisiting a saved, unchanged intake via the stepper adds no request", rowsFor(company).length === 1);
    await tab.ev(stepper(0));
    await tab.waitFor(onStep(0));
    await tab.ev(setVal("#f-wage", "31"));
    await tab.ev(clearToast);
    await tab.ev(click("#next"));
    check("editing a saved intake and continuing succeeds", await tab.waitFor(`${onStep(1)} && /Changes saved/.test(document.querySelector("#toast").textContent)`));
    row = rowsFor(company)[0];
    check("...updates the same record: still exactly one request", rowsFor(company).length === 1 && row.profile.hourlyLaborCost === 31, `rows=${rowsFor(company).length}`);
    check("...and keeps its follow-up answers", row.followUps?.length === 3);
    await tab.ev(stepper(4));
    await tab.waitFor(onStep(4));

    // 3. Developer role, all screens, and back
    await tab.ev(`document.querySelector('#role [data-role="dev"]').click()`);
    check("Developer role opens the team profile", await tab.waitFor(`S.role === "dev" && S.dstep === 0 && !!document.querySelector("#d-team")`));
    await tab.ev(click("#next"));
    check("profile -> bounty board", await tab.waitFor(`S.dstep === 1`));
    check("board shows this operator's bounty as their saved demo submission", await tab.ev(`document.body.innerText.includes("your saved demo submission")`));
    check("sample bounties are labelled as samples", await tab.ev(`document.body.innerText.includes("Bait station checking robot for commercial sites") && /· sample/.test(document.body.innerText)`));
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
    check("after a refresh the edited value is shown", await tab.ev(`document.querySelector("#f-wage").value === "31"`));
    check("after a refresh the posted bounty is restored", await tab.waitFor(`S.posted && S.bountySave.id === ${JSON.stringify(bRows[0]._id)} && S.gapNote === ${JSON.stringify(note)}`));
    check("after a refresh all follow-up answers are restored", await tab.waitFor(`S.answered === 3 && S.answers.slope === 15 && S.answers.obstacles === 1 && S.answers.weeks === 26`));
    await tab.ev(stepper(1));
    check("restored answers show as selected on the follow-up screen",
      await tab.waitFor(`${onStep(1)} && document.querySelectorAll('.chip[data-q][aria-pressed="true"]').length === 3 && document.body.innerText.includes("Answers saved")`));
    // Follow-up save failure: error, no success, nothing changed
    await tab.ev(breakNetwork);
    await tab.ev(`document.querySelector('.chip[data-q="2"][data-v="45"]').click()`);
    await tab.ev(clearToast);
    await tab.ev(click("#next"));
    check("a failed answer save shows an error and stays on follow-ups", await tab.waitFor(`${noticeHas("Can't reach the Rivet server")} && ${onStep(1)}`));
    check("...with no success message and the stored answer unchanged",
      !(await tab.ev(toastSaysSaved)) && rowsFor(company)[0].followUps[2].answerLabel === "About 26");
    // Bounty post failure: no success, nothing changed
    await tab.ev("go(4)"); // jump straight to the bounty page (the stepper would try to save answers first)
    await tab.waitFor(`${onStep(4)} && !!document.querySelector("#edit")`);
    await tab.ev(click("#edit"));
    await tab.waitFor(`!!document.querySelector("#pledge")`);
    await tab.ev(`(() => { const p = document.querySelector("#pledge"); p.value = "40"; p.dispatchEvent(new Event("input")); })()`);
    await tab.ev(clearToast);
    const postSync = await tab.ev(`(() => { document.querySelector("#post").click(); const b = document.querySelector("#post"); return { disabled: b.disabled, text: b.textContent }; })()`);
    check("Post bounty shows a disabled Posting state immediately", postSync.disabled && /Posting/.test(postSync.text), JSON.stringify(postSync));
    check("a failed bounty post shows an error and is not marked posted",
      await tab.waitFor(`${noticeHas("Can't reach the Rivet server")} && !S.posted && !document.querySelector("#post").disabled`));
    check("...with no success message and the stored bounty unchanged",
      !(await tab.ev(`/posted/i.test(document.querySelector("#toast").textContent)`)) && bountiesFor(draftId)[0].pledgePercent === 30);
    await tab.ev("go(1)");
    await tab.waitFor(onStep(1));
    // Intake update failure: same guarantees
    await tab.ev(click("#back"));
    await tab.waitFor(onStep(0));
    await tab.ev(setVal("#f-wage", "44"));
    await tab.ev(clearToast);
    await tab.ev(click("#next"));
    check("a failed intake update shows an error and stays on step 1", await tab.waitFor(`${noticeHas("Can't reach the Rivet server")} && ${onStep(0)}`));
    check("...with no success message and the stored record unchanged",
      !(await tab.ev(toastSaysSaved)) && rowsFor(company)[0].profile.hourlyLaborCost === 31 && rowsFor(company).length === 1);
    const realDraft = JSON.parse(await tab.ev(`localStorage.getItem("rivet.intake.draft")`));
    await tab.close();

    // A different person (separate browser context, empty storage) sees the bounty as a Developer
    tab = await open(null, true);
    check("a separate browser session starts with no draft", await tab.ev(`localStorage.getItem("rivet.intake.draft") === null`));
    await tab.ev(`document.querySelector('#role [data-role="dev"]').click()`);
    await tab.waitFor(`S.role === "dev"`);
    await tab.ev(click("#next"));
    const savedSel = `[data-sel="saved-${bRows[0]._id}"]`;
    check("the Developer board in another session shows the posted bounty",
      await tab.waitFor(`S.dstep === 1 && !!document.querySelector(${JSON.stringify(savedSel)})`));
    const card = `document.querySelector(${JSON.stringify(savedSel)}).closest("article")`;
    check("...labelled as a saved demo submission, with its title",
      await tab.ev(`${card}.textContent.includes("saved demo submission") && ${card}.textContent.includes(${JSON.stringify(bountyTitleText)})`));
    check("...without the company's name anywhere on the board", !(await tab.ev(`document.body.innerText.includes(${JSON.stringify(company)})`)));
    await tab.ev(click(savedSel));
    check("the claim screen lists the raw note as text and runs no markup",
      await tab.waitFor(`S.dstep === 2 && document.querySelector(".spec").textContent.includes(${JSON.stringify(note)})`) &&
      (await tab.ev(`window.__xss === undefined && !document.querySelector(".spec img")`)));
    check("no script errors in the developer session", tab.errors.length === 0, tab.errors.join(" | "));
    await tab.close();

    // Wrong token: the draft is not shown and is forgotten
    tab = await open(`${FRESH} localStorage.setItem("rivet.intake.draft", JSON.stringify({ id: ${JSON.stringify(realDraft.id)}, token: "not-the-right-token" }));`);
    check("a stored draft with a wrong token is rejected and forgotten",
      await tab.waitFor(`localStorage.getItem("rivet.intake.draft") === null`));
    check("...and none of its data is shown", await tab.ev(`document.querySelector("#f-name").value !== ${JSON.stringify(company)} && !document.body.innerText.includes("Saved to Rivet")`));
    await tab.close();

    // 5. Leaving step 1 through the stepper saves first
    const company2 = `Fictional E2E Pest ${RUN}`;
    tab = await open(FRESH);
    await tab.ev(setVal("#f-name", company2));
    await tab.ev(stepper(3));
    check("stepper jump from step 1 saves, then lands on the chosen step", await tab.waitFor(onStep(3)));
    check("...with exactly one request", rowsFor(company2).length === 1);
    await tab.ev(stepper(1));
    await tab.waitFor(onStep(1));
    await tab.ev(`document.querySelector('.chip[data-q="0"][data-v="28"]').click()`);
    await tab.ev(stepper(3));
    check("leaving follow-ups early through the stepper saves first", await tab.waitFor(onStep(3)));
    const partial = rowsFor(company2)[0];
    check("only the one answered question is stored, never the defaults",
      partial?.followUps?.length === 1 && partial.followUps[0].key === "slope" && partial.followUps[0].answerLabel === "A lot of them" && partial.followUpsComplete === false,
      JSON.stringify(partial?.followUps));
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

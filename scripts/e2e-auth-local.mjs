// Live account and authorization checks against a LOCAL Convex backend, with real
// JWT verification: tokens are signed by scripts/local-auth-issuer.mjs, which the
// local deployment's CLERK_FRONTEND_API_URL points at. Real Clerk is not involved,
// so this proves Convex's checks and our wiring, not Clerk's own behaviour.
//
//   node scripts/local-auth-issuer.mjs                        # terminal 1
//   npx convex dev                                            # terminal 2, a LOCAL deployment
//   npx convex env set CLERK_FRONTEND_API_URL http://127.0.0.1:8790
//   npx convex env set RIVET_SERVER_SECRET local-test-secret-not-real
//   npm run e2e:auth
//
// Refuses to run against anything but 127.0.0.1. Never calls Anthropic: /api/chat is
// exercised with Claude's endpoint stubbed. Leaves fictional "E2E-TEST " rows and test
// accounts in the local database.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import handler from "../api/chat.js";

const ROOT = new URL("..", import.meta.url).pathname;
const ISSUER = process.env.RIVET_TEST_ISSUER || "http://127.0.0.1:8790";
const SECRET = process.env.RIVET_TEST_SERVER_SECRET || "local-test-secret-not-real";
let env = "";
try { env = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { /* none */ }
const URL_ = env.match(/^CONVEX_URL=(\S+)/m)?.[1];
if (!URL_ || !/^http:\/\/127\.0\.0\.1:\d+$/.test(URL_) || !/^CONVEX_DEPLOYMENT=(anonymous|local):/m.test(env)) {
  console.error(`Refusing: .env.local must point at a local deployment (found ${URL_}).`);
  process.exit(2);
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ISSUER)) { console.error("Refusing: the test issuer must be local."); process.exit(2); }
console.log(`Local backend ${URL_}, local test issuer ${ISSUER}\n`);

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const mint = async (sub, q = "") =>
  (await (await fetch(`${ISSUER}/mint?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(sub + "@example.test")}${q}`)).json()).token;
const rejects = async (p, re) => {
  try { await p; return false; } catch (e) { return re.test(String(e.data ?? e.message)); }
};
// Admin calls go through the Convex CLI (internal functions), like a real admin would.
const cli = (fn, args) => {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return out ? JSON.parse(out) : null;
};
// Refused calls are expected here; don't echo each server error.
const client = () => new ConvexClient(URL_, { logger: false });

// A signed-in browser: a WebSocket client whose tokens come from the issuer.
async function person(label, q = "") {
  const sub = `user_e2e_${label}_${RUN}`;
  const c = client();
  let fetches = 0;
  c.setAuth(async () => { fetches++; return await mint(sub, q); });
  return { sub, c, fetches: () => fetches };
}

const intake = (name) => ({
  title: `E2E-TEST ${name} — Lawn care automation request`,
  description: "Fictional demo: we mow 50 lawns a week.",
  environment: "Lawn care operation, West region, 2 crews of 2 people.",
  constraints: [],
  profile: { companyName: `E2E-TEST ${name}`, businessType: "lawn", region: "West", crewCount: 2, peoplePerCrew: 2, hourlyLaborCost: 24, visibility: "shared" },
});
const bounty = (title) => ({
  taskKey: "mow", title, specLines: ["Works on slopes up to 20°", "<b>markup</b> stays text"], gaps: ["Can't handle slopes"],
  note: "Fictional", industry: "Lawn care", pledgePercent: 30, pledged: 4500, goal: 150000,
});

const anon = client();
const people = [];
try {
  // ---- signed out -------------------------------------------------------------------
  check("signed out: me says signed out", (await anon.query("users:me", {})).signedIn === false);
  check("signed out: creating a request is refused", await rejects(anon.mutation("requests:create", intake("Anon " + RUN)), /Please sign in/));
  check("signed out: the bounty board is refused", await rejects(anon.query("bounties:listPosted", {}), /Please sign in/));

  // ---- forged, expired, wrong-audience tokens ----------------------------------------
  const http = new ConvexHttpClient(URL_);
  http.setAuth(await mint("user_x", "&aud=not-convex"));
  check("a token for another audience is rejected by Convex", await rejects(http.query("users:me", {}), /NoAuthProvider|No auth provider/));
  http.setAuth(await mint("user_x", "&expired=1"));
  check("an expired token is rejected by Convex", await rejects(http.query("users:me", {}), /Unauthenticated|verify/));
  const good = await mint("user_x");
  const [h, p] = good.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), sub: "user_victim" })).toString("base64url");
  http.setAuth(`${h}.${forgedPayload}.${good.split(".")[2]}`);
  check("a token with a tampered subject is rejected by Convex", await rejects(http.query("users:me", {}), /Unauthenticated|verify/));

  // ---- registration and roles ----------------------------------------------------------
  const alice = await person("alice"); people.push(alice);
  const bob = await person("bob"); people.push(bob);
  const dana = await person("dana"); people.push(dana);
  const devon = await person("devon"); people.push(devon);
  check("new sign-in has no role yet", (await alice.c.mutation("users:ensureAccount", {})).role === null);
  check("a signed-in account without a role can't create requests", await rejects(alice.c.mutation("requests:create", intake("NoRole " + RUN)), /Finish setting up/));
  await alice.c.mutation("users:chooseRole", { role: "client", name: "Alice E2E", organization: "E2E-TEST Co" });
  await bob.c.mutation("users:chooseRole", { role: "client" });
  check("Developer sign-up starts pending", (await dana.c.mutation("users:chooseRole", { role: "developer" })).developerStatus === "pending");
  await devon.c.mutation("users:chooseRole", { role: "developer" });
  const again = client();
  again.setAuth(async () => await mint(alice.sub));
  check("role persists for a new session of the same person", (await again.query("users:me", {})).account?.role === "client");
  await again.close();
  check("a Client can't switch itself to Developer", await rejects(alice.c.mutation("users:chooseRole", { role: "developer" }), /already set/));
  check("a pending Developer can't read the board", await rejects(dana.c.query("bounties:listPosted", {}), /approved Developer/));
  check("a Client can't read the Developer board", await rejects(alice.c.query("bounties:listPosted", {}), /approved Developer/));

  // ---- approval: invite code and admin --------------------------------------------------
  const { code } = cli("users:createDeveloperInvite", { note: "E2E-TEST invite", days: 1 });
  check("an invite approves a pending Developer", (await dana.c.mutation("users:redeemDeveloperInvite", { code })).approvedDeveloper === true);
  check("the same invite can't be used twice", await rejects(devon.c.mutation("users:redeemDeveloperInvite", { code }), /isn't valid/));
  cli("users:setDeveloperStatus", { clerkUserId: devon.sub, status: "approved" });
  check("an admin approval takes effect", (await devon.c.query("users:me", {})).account?.approvedDeveloper === true);

  // ---- client request, follow-ups, duplicates ---------------------------------------------
  const token = `e2e-${RUN}-retry-key`;
  const ids = await Promise.all([1, 2, 3].map(() => alice.c.mutation("requests:create", { ...intake("Alice " + RUN), clientToken: token })));
  check("duplicate submits (same retry key) create one request", new Set(ids).size === 1);
  const reqId = ids[0];
  check("the retry key from another account is refused", await rejects(bob.c.mutation("requests:create", { ...intake("Bob " + RUN), clientToken: token }), /already in use/));
  await alice.c.mutation("requests:saveFollowUps", {
    id: reqId, complete: true,
    answers: [{ key: "slope", question: "Slopes?", answerLabel: "Some", assumption: { value: 20, unit: "degrees" } }],
  });
  const mine = await alice.c.query("requests:listMine", {});
  check("listMine returns the owner's request without token or owner id", mine[0]?._id === reqId && !("clientToken" in mine[0]) && !("ownerId" in mine[0]));

  // ---- cross-account protection -------------------------------------------------------------
  check("another Client can't read the request", await rejects(bob.c.query("requests:getDraft", { id: reqId }), /Draft not found/));
  check("another Client can't edit the request", await rejects(bob.c.mutation("requests:updateIntake", { id: reqId, ...intake("Hijack") }), /Draft not found/));
  check("another Client can't post a bounty on it", await rejects(bob.c.mutation("bounties:post", { requestId: reqId, ...bounty("Hijack") }), /Draft not found/));
  check("another Client can't start paid AI on it", await rejects(bob.c.mutation("agent:generateSpec", { requestId: reqId }), /Draft not found/));
  check("a Developer can't touch Client requests", await rejects(dana.c.query("requests:getDraft", { id: reqId }), /Client account/));
  check("the old draft token grants nothing", await rejects(bob.c.query("agent:specStatus", { requestId: reqId, clientToken: token }), /Draft not found/));

  // ---- real-time board ------------------------------------------------------------------------
  const seen = [];
  let boardError = null;
  const stop = dana.c.onUpdate("bounties:listPosted", { limit: 50 }, (rows) => seen.push(rows), (e) => { boardError = e; });
  for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(100);
  const before = seen.at(-1)?.length ?? -1;
  check("Developer board subscription starts", before >= 0 && !boardError, `(${before} posted already)`);
  cli("agent:saveBounty", { requestId: reqId, title: `E2E-TEST private AI draft ${RUN}`, summary: "s", mustHaves: ["m"], niceToHaves: [], acceptanceTest: "a", goal: 1000 });
  const title = `E2E-TEST live bounty ${RUN}`;
  const t0 = Date.now();
  const bountyId = await alice.c.mutation("bounties:post", { requestId: reqId, ...bounty(title) });
  let row = null;
  for (let i = 0; i < 100 && !row; i++) { row = seen.at(-1)?.find((b) => b._id === bountyId); if (!row) await sleep(50); }
  check("a posted bounty reaches the Developer's open board without a refresh", !!row, row ? `(${Date.now() - t0} ms)` : "");
  check("the board shows only public fields", !!row && !("requestId" in row) && !("ownerId" in row) && !JSON.stringify(row).includes("E2E-TEST Alice"));
  check("private AI drafts never reach the board", !seen.at(-1)?.some((b) => b.title.includes("private AI draft")));
  const repeat = await alice.c.mutation("bounties:post", { requestId: reqId, ...bounty(title), pledged: 6000 });
  for (let i = 0; i < 60 && seen.at(-1)?.find((b) => b._id === bountyId)?.pledged !== 6000; i++) await sleep(50);
  check("re-posting the same task updates one bounty, live", repeat === bountyId && seen.at(-1).filter((b) => b.title === title).length === 1 && seen.at(-1).find((b) => b._id === bountyId).pledged === 6000);
  stop();

  // ---- token refresh, expiry and logout -------------------------------------------------------
  const short = await person("short", "&ttl=12"); people.push(short);
  await short.c.mutation("users:chooseRole", { role: "client" });
  const firstFetches = short.fetches();
  await sleep(14000);
  const after = await short.c.query("users:me", {}).catch((e) => ({ error: String(e.message) }));
  check("an expiring session token is refreshed and calls keep working", after.account?.role === "client" && short.fetches() > firstFetches, `(token fetched ${short.fetches()}x)`);
  // Logout. js/rivet-api.js closes the socket and opens a fresh one, because
  // de-authenticating an open socket did not work (see the next check).
  short.c.setAuth(async () => null);
  await sleep(500);
  const stillIn = await short.c.mutation("users:ensureAccount", {}).then(() => true, () => false);
  console.log(`INFO  convex client: after setAuth(() => null) the socket ${stillIn ? "STILL acts as the user (why the app closes it)" : "is signed out"}`);
  await short.c.close();
  const fresh = client();
  check("after logout a fresh connection is signed out", await rejects(fresh.mutation("requests:create", intake("Short " + RUN)), /Please sign in/));
  await fresh.close();

  // ---- /api/chat: Convex verifies the forwarded token -------------------------------------------
  Object.assign(process.env, { CHAT_ENABLED: "true", ANTHROPIC_API_KEY: "test-key-not-real", CONVEX_URL: URL_, RIVET_SERVER_SECRET: SECRET });
  const realFetch = globalThis.fetch;
  let claudeCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.anthropic.com/")) {
      claudeCalls++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Stubbed reply (no paid call)." }], stop_reason: "end_turn" }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const chat = async (authorization) => {
    const res = { statusCode: 0, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await handler({ method: "POST", headers: { "x-vercel-forwarded-for": "198.51.100.23", ...(authorization ? { authorization } : {}) }, body: { message: "Fictional: we mow lawns.", mode: "opening" } }, res);
    return res;
  };
  check("/api/chat without a token: 401, no Claude call", (await chat(null)).statusCode === 401 && claudeCalls === 0);
  check("/api/chat with an expired token: 401, no Claude call", (await chat(`Bearer ${await mint(alice.sub, "&expired=1")}`)).statusCode === 401 && claudeCalls === 0);
  check("/api/chat with a Developer token: 403, no Claude call", (await chat(`Bearer ${await mint(dana.sub)}`)).statusCode === 403 && claudeCalls === 0);
  const ok = await chat(`Bearer ${await mint(alice.sub)}`);
  check("/api/chat with a Client token: budget reserved, (stubbed) reply returned", ok.statusCode === 200 && ok.body?.reply && claudeCalls === 1);
  globalThis.fetch = realFetch;
} catch (e) {
  failed++;
  console.log("FAIL  unexpected error:", e?.data ?? e?.message ?? e);
} finally {
  await Promise.all([anon, ...people.map((x) => x.c)].map((c) => c.close().catch(() => {})));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll live auth checks passed");
process.exit(failed ? 1 : 0);

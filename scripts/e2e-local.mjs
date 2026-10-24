// Live check against a RUNNING local Convex backend (npx convex dev). Not part of
// `npm test`. Uses fictional data only; each run leaves a few rows in the dev database.
import { execFileSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import "../js/rivet-api.js"; // classic browser script; attaches globalThis.RivetApi

const url = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const api = globalThis.RivetApi;
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const QUESTIONS = [
  { key: "slope", q: "How many of your properties have slopes steeper than about 20°?", opts: [["Very few", 15], ["Some", 20], ["A lot of them", 28]] },
  { key: "obstacles", q: "Are most sites wide open, or full of beds, toys, fences and other obstacles?", opts: [["Mostly open", 1], ["Mixed", .85], ["Lots of obstacles", .7]] },
  { key: "weeks", q: "How many weeks a year are your crews out working?", opts: [["About 26", 26], ["About 32", 32], ["Most of the year (45)", 45]] },
];

const raw = new ConvexHttpClient(url);
api._setClient(raw);
const form = {
  type: "lawn", name: `E2E Fictional Lawn Co. ${Date.now().toString(36)}`, describe: "Fictional demo: we mow 50 lawns a week.",
  crews: 2, perCrew: 2, wage: 24, region: "West", visibility: "anon",
};
const token = api.newClientToken();
const args = { ...api.intakeToRequest(form), clientToken: token };

// --- create: idempotent by token ---
const id = await api.createRequest(args);
check("create returns an id", typeof id === "string" && id.length > 10, id);
check("same clientToken returns the same id (no duplicate)", (await api.createRequest(args)) === id);
const concurrent = await Promise.all(Array.from({ length: 5 }, () => api.createRequest(args)));
check("5 concurrent submits with one token -> one id", concurrent.every((x) => x === id));

// --- legacy public endpoints are gone (cannot bypass the token) ---
for (const [kind, name, a] of [["query", "requests:get", { id }], ["query", "requests:list", {}]]) {
  const err = await raw[kind](name, a).then(() => null, (e) => e);
  check(`legacy public ${name} is not callable`, !!err && /Could not find public function/.test(err.message), err ? err.message.split("\n")[0].slice(0, 90) : "it returned data!");
}

// --- token-protected read, as after a page refresh (fresh client) ---
api._setClient(new ConvexHttpClient(url));
const draft = await api.getDraft(id, token);
check("getDraft with the right token returns the draft", draft?._id === id && draft.description === form.describe);
check("getDraft never returns the token", !("clientToken" in draft));
const back = api.requestToIntake(draft);
check("requestToIntake restores every intake field",
  Object.keys(form).every((k) => back?.[k] === form[k]) && Object.keys(back ?? {}).length === Object.keys(form).length,
  JSON.stringify(back));
const wrong = await api.getDraft(id, api.newClientToken()).catch((e) => e);
check("getDraft with a wrong token is rejected", api.isDraftMissing(wrong), String(wrong?.data ?? wrong?.message));
const wrongUpdate = await api.updateIntake(id, "not-the-token", api.intakeToRequest({ ...form, describe: "hijack" })).catch((e) => e);
check("updateIntake with a wrong token is rejected", api.isDraftMissing(wrongUpdate));

// --- edit in place ---
const edited = { ...form, describe: "Fictional demo: edited after saving.", crews: 4 };
check("updateIntake returns the same id", (await api.updateIntake(id, token, api.intakeToRequest(edited))) === id);
const afterEdit = await api.getDraft(id, token);
check("the edit is stored on the same record", afterEdit.description === edited.describe && afterEdit.profile.crewCount === 4);
check("a retried update is harmless", (await api.updateIntake(id, token, api.intakeToRequest(edited))) === id);

// --- follow-ups: only answered questions, then restore ---
const partial = api.followUpsFromState({ answers: { slope: 28, obstacles: .85, weeks: 32 }, answered: 1 }, QUESTIONS);
await api.saveFollowUps(id, token, partial);
let saved = await api.getDraft(id, token);
check("partial answers save only what was picked", saved.followUps.length === 1 && saved.followUps[0].answerLabel === "A lot of them" && saved.followUpsComplete === false);
const full = api.followUpsFromState({ answers: { slope: 28, obstacles: .7, weeks: 45 }, answered: 3 }, QUESTIONS);
await api.saveFollowUps(id, token, full);
await api.saveFollowUps(id, token, full); // repeated
saved = await api.getDraft(id, token);
check("full answers replace the set and mark it complete", saved.followUps.length === 3 && saved.followUpsComplete === true);
const restored = api.followUpsToState(saved.followUps, QUESTIONS);
check("answers restore to the same selections", JSON.stringify(restored) === JSON.stringify({ answers: { slope: 28, obstacles: .7, weeks: 45 }, answered: 3 }), JSON.stringify(restored));
check("the obstacle factor is stored without a unit", saved.followUps[1].assumption.value === 0.7 && !("unit" in saved.followUps[1].assumption));
const wrongAnswers = await api.saveFollowUps(id, "not-the-token", partial).catch((e) => e);
check("saveFollowUps with a wrong token is rejected", api.isDraftMissing(wrongAnswers));

// --- agent endpoints (merged from feature/agent) ---
for (const name of ["ai:hello", "ai:runEvals"]) {
  const err = await raw.action(name, {}).then(() => null, (e) => e);
  check(`${name} is not callable from a browser (would spend the API key)`, !!err && /Could not find public function/.test(err.message));
}
const agentWrong = await raw.query("agent:latestSpec", { requestId: id, clientToken: "not-the-token" }).catch((e) => e);
check("agent:latestSpec rejects a wrong token", api.isDraftMissing(agentWrong));
const agentNoToken = await raw.query("agent:latestSpec", { requestId: id }).catch((e) => e);
check("agent:latestSpec without a token is rejected", agentNoToken instanceof Error);
const agentRuns = () => execFileSync("npx", ["convex", "data", "agentRuns", "--limit", "50", "--format", "jsonLines"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const runsBefore = agentRuns().length;
const startedAt = Date.now();
await raw.mutation("agent:generateSpec", { requestId: id, clientToken: token });
let failedRun = null;
for (let i = 0; i < 40 && !failedRun; i++) {
  await new Promise((r) => setTimeout(r, 500));
  failedRun = agentRuns().find((r) => r.route === "spec" && r._creationTime >= startedAt - 1000) ?? null;
}
check("without an API key a deliberate spec request fails gracefully and is logged",
  failedRun?.ok === false && /authentication|api key|apiKey/i.test(failedRun.note ?? ""),
  failedRun ? `${failedRun.note?.slice(0, 80)}` : `no run logged (runs before: ${runsBefore})`);
check("...no spec is stored for the request", (await raw.query("agent:latestSpec", { requestId: id, clientToken: token })) === null);
check("...and the request itself is untouched and still readable", (await api.getDraft(id, token)).status === "submitted");

// --- errors ---
const bad = await api.createRequest({ ...args, clientToken: api.newClientToken(), description: "  " }).catch((e) => e);
check("empty description rejected with a readable message", api.friendlyError(bad) === "description must not be empty", api.friendlyError(bad));
api._setClient(new ConvexHttpClient("http://127.0.0.1:1")); // nothing listens here
const down = await api.createRequest(args).catch((e) => e);
check("unreachable backend -> connection error message", /Can't reach the Rivet server/.test(api.friendlyError(down)), api.friendlyError(down));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll live checks passed");
process.exit(failed ? 1 : 0);

// Live check against a RUNNING local Convex backend (npx convex dev). Not part of
// `npm test`. Uses fictional data only. Each run leaves 2 rows in the dev database.
import { ConvexHttpClient } from "convex/browser";
import "../js/rivet-api.js"; // classic browser script; attaches globalThis.RivetApi

const url = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const api = globalThis.RivetApi;
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

api._setClient(new ConvexHttpClient(url));
const form = {
  type: "lawn", name: "E2E Fictional Lawn Co.", describe: "Fictional demo: we mow 50 lawns a week.",
  crews: 2, perCrew: 2, wage: 24, region: "West", visibility: "shared",
};
const token = api.newClientToken();
const args = { ...api.intakeToRequest(form), clientToken: token };

const id = await api.createRequest(args);
check("create returns an id", typeof id === "string" && id.length > 10, id);

const again = await api.createRequest(args);
check("same clientToken returns the same id (no duplicate)", again === id);

const concurrent = await Promise.all(Array.from({ length: 5 }, () => api.createRequest(args)));
check("5 concurrent submits with one token -> one id", concurrent.every((x) => x === id));

// "Page refresh": brand-new client instance and no shared state.
api._setClient(new ConvexHttpClient(url));
const doc = await api.getRequest(id);
check("get by id after a fresh client returns the stored request", doc?._id === id);
check("stored description matches", doc?.description === form.describe);
const back = api.requestToIntake(doc);
check("requestToIntake restores every intake field",
  Object.keys(form).every((k) => back?.[k] === form[k]) && Object.keys(back ?? {}).length === Object.keys(form).length,
  JSON.stringify(back));
check("round-trip fingerprint is stable (unchanged form => no re-save)",
  JSON.stringify(api.intakeToRequest({ ...form, ...back })) === JSON.stringify(api.intakeToRequest(form)));

const bad = await api.createRequest({ ...args, clientToken: api.newClientToken(), description: "  " }).catch((e) => e);
check("empty description rejected with a readable message", api.friendlyError(bad) === "description must not be empty", api.friendlyError(bad));

api._setClient(new ConvexHttpClient("http://127.0.0.1:1")); // nothing listens here
const down = await api.createRequest(args).catch((e) => e);
check("unreachable backend -> connection error message", /Can't reach the Rivet server/.test(api.friendlyError(down)), api.friendlyError(down));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll live checks passed");
process.exit(failed ? 1 : 0);

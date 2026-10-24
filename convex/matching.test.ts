/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper, signedIn } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");

const intake = {
  title: "Fictional Hills Lawn Co. — Lawn care automation request",
  description: "Fictional: we mow steep lawns.",
  environment: "Lawn care operation, West region.",
  constraints: [],
};
const base = { vendor: "V", task: "mowing", environments: [], url: "https://example.com/r" };
const sample = (name: string, o: object = {}) => ({ ...base, name, price: 20000, yearlyOpex: 1500, automationShare: 0.6, sample: true, ...o });

async function setup() {
  const raw = convexTest(schema, modules);
  const t = await asClient(raw);
  const requestId = await t.mutation(api.requests.create, intake);
  const robot = (r: object) => raw.run((ctx) => ctx.db.insert("robots", r as any));
  const ids = {
    flat: await robot(sample("Flat fictional mower", { slopeLimitDeg: 10 })),
    hill: await robot(sample("Hill fictional mower", { slopeLimitDeg: 30, price: 40000 })),
    vendor: await robot({
      ...base, name: "Vendor-page mower", vendor: "Real Co", price: 30000, yearlyOpex: 2000, automationShare: 0.5, sample: false,
      priceStatus: "listed", fetchedAt: 1_700_000_000_000, provenance: "Read from https://example.com/vendor",
      specs: [{ name: "max_slope_deg", value: 35, quote: "climbs 35 degree slopes", sourceUrl: "https://example.com/vendor" }],
    }),
    unverified: await robot({ ...base, name: "Imported mower", price: 25000, yearlyOpex: 2000, automationShare: 0.5, sample: false }),
    other: await robot(sample("Fictional inspector", { task: "inspection" })),
    // One robot of each provenance kind for the task "edging" (all three fit in the top three).
    edgeFake: await robot(sample("Fictional edger", { task: "edging" })),
    edgeVendor: await robot({
      ...base, task: "edging", name: "Vendor-page edger", vendor: "Real Co", price: 9000, yearlyOpex: 500, automationShare: 0.4, sample: false,
      priceStatus: "listed", fetchedAt: 1_700_000_000_000, provenance: "Read from https://example.com/edger",
      specs: [{ name: "runtime_hours", value: 3, quote: "runs about three hours", sourceUrl: "https://example.com/edger" }],
    }),
    edgeUnverified: await robot({ ...base, task: "edging", name: "Imported edger", price: 8000, yearlyOpex: 500, automationShare: 0.4, sample: false }),
    sprayer: await robot(sample("Fictional sprayer", { task: "spraying", slopeLimitDeg: 10 })),
    quoteOnly: await robot({ ...base, task: "trimming", name: "Quote-only trimmer", vendor: "Ask Co", price: 0, yearlyOpex: 0, automationShare: 0.5, sample: false, priceStatus: "quote_only", fetchedAt: 1, specs: [] }),
  };
  const matchRows = () => raw.run((ctx) => ctx.db.query("matches").collect());
  const scheduled = () => raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { raw, t, requestId, ids, matchRows, scheduled };
}
const slope = (mandatory = true) => [{ name: "max_slope_deg", op: "atLeast" as const, value: 25, mandatory }];

describe("matching: ownership and roles", () => {
  it("only the owning Client can run it or read the result", async () => {
    const { raw, t, requestId, matchRows } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing" });
    const other = await asClient(raw, "user_client_b");
    await expect(other.mutation(api.matching.findRobots, { requestId, task: "mowing" })).rejects.toThrow(/Draft not found/);
    await expect(other.query(api.matching.latestMatch, { requestId })).rejects.toThrow(/Draft not found/);
    expect(await matchRows()).toHaveLength(1);
    expect(await t.query(api.matching.latestMatch, { requestId })).not.toBeNull();
  });

  it("refuses signed-out callers, accounts without a role, and Developers (approved or not)", async () => {
    const { raw, requestId, matchRows } = await setup();
    const args = { requestId, task: "mowing" };
    await expect(raw.mutation(api.matching.findRobots, args)).rejects.toThrow(/Please sign in/);
    await expect(raw.query(api.matching.latestMatch, { requestId })).rejects.toThrow(/Please sign in/);
    await expect(signedIn(raw, "user_new").mutation(api.matching.findRobots, args)).rejects.toThrow(/Finish setting up/);
    for (const approved of [true, false]) {
      const dev = await asDeveloper(raw, approved ? "user_dev_ok" : "user_dev_pending", approved);
      await expect(dev.mutation(api.matching.findRobots, args)).rejects.toThrow(/needs a Client account/);
      await expect(dev.query(api.matching.latestMatch, { requestId })).rejects.toThrow(/needs a Client account/);
    }
    expect(await matchRows()).toHaveLength(0);
  });

  it("the old draft token grants nothing and is not an argument", async () => {
    const { raw, requestId } = await setup();
    const other = await asClient(raw, "user_client_b");
    await expect(
      // @ts-expect-error clientToken is not accepted any more
      other.mutation(api.matching.findRobots, { requestId, task: "mowing", clientToken: "anything-at-all" }),
    ).rejects.toThrow();
  });

  it("the saved result never contains the owner id, token or other requests", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing" });
    const text = JSON.stringify(await t.query(api.matching.latestMatch, { requestId }));
    expect(text).not.toMatch(/ownerId|clientToken/);
  });
});

describe("matching: results", () => {
  it("ranks only the task's robots, best first, and saves them under the request", async () => {
    const { t, requestId, ids, matchRows } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: " Mowing ", annualTaskCost: 60000, requirements: slope() });
    const m = (await t.query(api.matching.latestMatch, { requestId }))!;
    expect(m.status).toBe("done");
    expect(m.intent).toMatchObject({ task: "mowing", annualTaskCost: 60000, budget: null });
    expect(m.picks).toHaveLength(3);
    expect(m.picks.map((p) => p.robotId)).not.toContain(ids.other); // other task excluded
    expect(m.picks[0].robotId).toBe(ids.vendor); // 35 deg meets 25; best payback among the meeters
    expect(m.picks.find((p) => p.robotId === ids.flat)).toBeUndefined(); // 10 deg misses, ranked out of the top three
    const row = (await matchRows())[0];
    expect(row.requestId).toBe(requestId);
  });

  it("computes payback and savings from the saved annual cost, and saves that cost on the request", async () => {
    const { t, requestId, ids } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    const flat = (await t.query(api.matching.latestMatch, { requestId }))!.picks.find((p) => p.robotId === ids.flat)!;
    // net = 60000*0.6 - 1500 = 34500/yr; payback = 20000/34500*12 ~ 7 months
    expect(flat.yearlyNetSavings).toBe(34500);
    expect(Math.round(flat.paybackMonths!)).toBe(7);
    expect((await t.query(api.requests.getDraft, { id: requestId })).cost).toMatchObject({ currency: "USD", currentAnnualCost: 60000 });
  });

  it("asks for the annual cost when unknown, and suggests a bounty when a mandatory requirement is unmet", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing" });
    expect((await t.query(api.matching.latestMatch, { requestId }))!.next).toEqual({ kind: "ask", field: "annualTaskCost" });
    // The only spraying robot handles 10 degrees: a mandatory 60 degrees can't be met.
    await t.mutation(api.matching.findRobots, { requestId, task: "spraying", annualTaskCost: 60000,
      requirements: [{ name: "max_slope_deg", op: "atLeast", value: 60, mandatory: true }] });
    const m = (await t.query(api.matching.latestMatch, { requestId }))!;
    expect(m.next).toMatchObject({ kind: "suggest_bounty", gaps: ["Max slope (degrees) at least 60"] });
    expect(m.picks[0].fit[0]).toMatchObject({ status: "misses", mandatory: true });
  });

  it("an unknown task finds no robots and suggests a bounty", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "gutter cleaning", annualTaskCost: 1000 });
    const m = (await t.query(api.matching.latestMatch, { requestId }))!;
    expect(m.picks).toEqual([]);
    expect(m.next).toEqual({ kind: "suggest_bounty", gaps: ["No robot found for this task"] });
  });

  it("without explicit requirements, the saved slope answer becomes a non-mandatory requirement, noted as illustrative", async () => {
    const { t, requestId, ids } = await setup();
    await t.mutation(api.requests.saveFollowUps, { id: requestId, complete: false,
      answers: [{ key: "slope", question: "Slopes?", answerLabel: "A lot of them", assumption: { value: 28, unit: "degrees" } }] });
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    const m = (await t.query(api.matching.latestMatch, { requestId }))!;
    expect(m.intent!.requirements).toEqual([{ name: "max_slope_deg", op: "atLeast", value: 28, mandatory: false }]);
    const hill = m.picks.find((p) => p.robotId === ids.hill)!;
    expect(hill.fit[0]).toMatchObject({ status: "meets", mandatory: false });
    expect(hill.assumptions.join(" ")).toMatch(/illustrative/);
  });

  it("a quote-only price gets no payback figure and is 'unknown' against a budget", async () => {
    const { raw, t, requestId, ids } = await setup();
    await raw.run((ctx) => ctx.db.patch(requestId, { cost: { currency: "USD", currentAnnualCost: 60000, budget: 35000 } }));
    await t.mutation(api.matching.findRobots, { requestId, task: "trimming" });
    const q = (await t.query(api.matching.latestMatch, { requestId }))!.picks.find((p) => p.robotId === ids.quoteOnly)!;
    expect(q.paybackMonths).toBeNull();
    expect(q.yearlyNetSavings).toBeNull();
    expect(q.price).toBeNull();
    expect(q.fit.find((f) => f.requirement.startsWith("Price"))!.status).toBe("unknown");
  });

  it("running it again replaces the saved result instead of adding rows", async () => {
    const { t, requestId, matchRows } = await setup();
    const a = await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    const b = await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 90000 });
    expect(b).toBe(a);
    expect(await matchRows()).toHaveLength(1);
    expect((await t.query(api.matching.latestMatch, { requestId }))!.intent!.annualTaskCost).toBe(90000);
  });

  it("latestMatch is null before any run", async () => {
    const { t, requestId } = await setup();
    expect(await t.query(api.matching.latestMatch, { requestId })).toBeNull();
  });
});

describe("matching: provenance", () => {
  async function edging() {
    const ctx = await setup();
    await ctx.t.mutation(api.matching.findRobots, { requestId: ctx.requestId, task: "edging", annualTaskCost: 30000 });
    const picks = (await ctx.t.query(api.matching.latestMatch, { requestId: ctx.requestId }))!.picks;
    return { ...ctx, picks, pick: (id: string) => picks.find((p) => p.robotId === id)! };
  }

  it("labels each robot by where its numbers come from", async () => {
    const { ids, picks, pick } = await edging();
    expect(picks).toHaveLength(3);
    expect(pick(ids.edgeFake).dataSource).toBe("fictional_sample");
    expect(pick(ids.edgeVendor).dataSource).toBe("vendor_sourced");
    expect(pick(ids.edgeUnverified).dataSource).toBe("unverified");
  });

  it("vendor-sourced robots carry their quotes, source URLs, fetch time and provenance note", async () => {
    const { ids, pick } = await edging();
    const v = pick(ids.edgeVendor);
    expect(v.specs[0]).toMatchObject({ quote: "runs about three hours", sourceUrl: "https://example.com/edger" });
    expect(v.provenance).toBe("Read from https://example.com/edger");
    expect(v.fetchedAt).toBe(1_700_000_000_000);
    expect(v.assumptions.join(" ")).not.toMatch(/Fictional/);
  });

  it("fictional robots carry the 'not vendor data' note; the others do not", async () => {
    const { ids, pick } = await edging();
    expect(pick(ids.edgeFake).assumptions.join(" ")).toMatch(/Fictional sample robot.*not vendor data/);
    expect(pick(ids.edgeUnverified).assumptions.join(" ")).not.toMatch(/Fictional/);
  });

  it("an imported robot with no source details is never presented as vendor-sourced", async () => {
    const { ids, pick } = await edging();
    const u = pick(ids.edgeUnverified);
    expect(u.dataSource).toBe("unverified");
    expect(u.specs).toEqual([]);
    expect(u.fetchedAt).toBeNull();
  });
});

describe("matching: validation, cost and regressions", () => {
  it.each([
    ["blank task", { task: "   " }, /task must be 1-60/],
    ["overlong task", { task: "x".repeat(61) }, /task must be 1-60/],
    ["zero annual cost", { annualTaskCost: 0 }, /annualTaskCost must be a positive/],
    ["NaN annual cost", { annualTaskCost: NaN }, /annualTaskCost must be a positive/],
    ["unknown requirement name", { requirements: [{ name: "magic", op: "atLeast", value: 1, mandatory: true }] }, /Unknown requirement/],
    ["negative requirement", { requirements: [{ name: "payload_kg", op: "atLeast", value: -1, mandatory: true }] }, /non-negative/],
    ["too many requirements", { requirements: Array.from({ length: 11 }, () => ({ name: "payload_kg", op: "atLeast", value: 1, mandatory: false })) }, /At most 10/],
  ])("rejects %s and saves nothing", async (_n, patch, message) => {
    const { t, requestId, matchRows } = await setup();
    await expect(t.mutation(api.matching.findRobots, { requestId, task: "mowing", ...(patch as object) } as any)).rejects.toThrow(message);
    expect(await matchRows()).toHaveLength(0);
    expect((await t.query(api.requests.getDraft, { id: requestId })).cost).toBeUndefined();
  });

  it("makes no AI or external request: nothing is scheduled and no API key is needed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { t, requestId, scheduled } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    expect(await scheduled()).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("spends no AI budget", async () => {
    const { raw, t, requestId } = await setup();
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    expect(await raw.run((ctx) => ctx.db.query("aiUsage").collect())).toHaveLength(0);
  });

  it("existing request, bounty-board and catalog behaviour is unchanged", async () => {
    const { raw, t, requestId, ids } = await setup();
    expect((await t.query(api.requests.listMine, {})).map((r) => r._id)).toEqual([requestId]);
    const dev = await asDeveloper(raw);
    await expect(dev.query(api.bounties.listPosted, {})).resolves.toEqual([]);
    const catalog = await raw.query(api.robots.search, { task: "mowing" });
    expect(catalog.map((r) => r._id)).toContain(ids.flat);
  });
});

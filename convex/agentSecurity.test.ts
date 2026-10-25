/// <reference types="vite/client" />
// Who may start the paid robot finder (agent:*) and the paid web search (discovery:*), and
// what switches and budgets stop it. No network: fetch is stubbed to fail, and scheduled jobs
// stay queued under fake timers, so nothing paid can run even if a check were missing.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper, signedIn } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup({ enabled = true } = {}) {
  if (enabled) vi.stubEnv("AI_MATCH_ENABLED", "true");
  const raw = convexTest(schema, modules);
  const t = await asClient(raw);
  const requestId = await t.mutation(api.requests.create, {
    title: "Fictional Hill Lawns — mowing", description: "Fictional: we mow steep lawns.",
    environment: "Lawn care, West region.", constraints: [],
  });
  const usage = () => raw.run((ctx) => ctx.db.query("aiUsage").collect());
  const matches = () => raw.run((ctx) => ctx.db.query("matches").collect());
  const scheduled = () => raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { raw, t, requestId, usage, matches, scheduled };
}

describe("agent robot finder: who may call it", () => {
  it("anonymous callers, other Clients and Developers can't start, price or read it", async () => {
    const { raw, requestId, usage, matches } = await setup();
    const callers: [string, any, RegExp][] = [
      ["anonymous", raw, /Please sign in/],
      ["no role yet", signedIn(raw, "user_new"), /Finish setting up/],
      ["another Client", await asClient(raw, "user_client_b"), /Draft not found/],
      ["approved Developer", await asDeveloper(raw), /needs a Client account/],
    ];
    for (const [, c, err] of callers) {
      await expect(c.mutation(api.agent.findRobots, { requestId })).rejects.toThrow(err);
      await expect(c.mutation(api.agent.setTaskCost, { requestId, annualTaskCost: 50000 })).rejects.toThrow(err);
      await expect(c.query(api.agent.latestMatch, { requestId })).rejects.toThrow(err);
    }
    expect(await usage()).toEqual([]);
    expect(await matches()).toEqual([]);
  });

  it("the owner can start it: one budget unit is spent and one job is queued", async () => {
    const { t, requestId, usage, scheduled } = await setup();
    await t.mutation(api.agent.findRobots, { requestId });
    expect((await usage()).map((u) => u.kind)).toEqual(["match"]);
    expect(await scheduled()).toHaveLength(1);
    expect((await t.query(api.agent.latestMatch, { requestId }))!.status).toBe("reading");
  });
});

describe("agent robot finder: switch and budget", () => {
  it("is off unless AI_MATCH_ENABLED=true: findRobots refuses, setTaskCost only saves the cost", async () => {
    const { raw, t, requestId, usage, matches, scheduled } = await setup({ enabled: false });
    await expect(t.mutation(api.agent.findRobots, { requestId })).rejects.toThrow(/turned off/);
    expect(await t.mutation(api.agent.setTaskCost, { requestId, annualTaskCost: 50000 })).toBeNull();
    expect((await raw.run((ctx) => ctx.db.get(requestId)))!.cost?.currentAnnualCost).toBe(50000);
    expect(await usage()).toEqual([]);
    expect(await matches()).toEqual([]);
    expect(await scheduled()).toEqual([]);
  });

  it("is off without an Anthropic key, even when switched on", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { t, requestId } = await setup();
    await expect(t.mutation(api.agent.findRobots, { requestId })).rejects.toThrow(/turned off/);
  });

  it("stops at the per-request limit before inserting or scheduling anything", async () => {
    vi.stubEnv("AI_REQUEST_DAILY_LIMIT", "1");
    const { raw, t, requestId, matches, scheduled } = await setup();
    await t.mutation(api.agent.findRobots, { requestId });
    // Finish the first run so the next call can't just rejoin it.
    await raw.run(async (ctx) => { for (const m of await ctx.db.query("matches").collect()) await ctx.db.patch(m._id, { status: "done" }); });
    await expect(t.mutation(api.agent.findRobots, { requestId })).rejects.toThrow(/reached its AI limit/);
    expect(await t.mutation(api.agent.setTaskCost, { requestId, annualTaskCost: 50000 })).toBeNull();
    expect(await matches()).toHaveLength(1);
    expect(await scheduled()).toHaveLength(1);
  });
});

describe("agent and rules matches stay apart", () => {
  it("a rules (matching.ts) result never shows up as an AI match, and vice versa", async () => {
    vi.stubEnv("SHOW_SAMPLE_ROBOTS", "true");
    const { raw, t, requestId } = await setup();
    await raw.run((ctx) => ctx.db.insert("robots", {
      name: "Fictional mower", vendor: "V", task: "mowing", price: 20000, yearlyOpex: 1500, automationShare: 0.6,
      environments: [], url: "https://example.com/r", sample: true,
    }));
    await t.mutation(api.matching.findRobots, { requestId, task: "mowing", annualTaskCost: 60000 });
    expect(await t.query(api.agent.latestMatch, { requestId })).toBeNull();
    await t.mutation(api.agent.findRobots, { requestId });
    expect((await t.query(api.agent.latestMatch, { requestId }))!.status).toBe("reading");
    expect((await t.query(api.matching.latestMatch, { requestId }))!.status).toBe("done");
  });
});

describe("web search (discovery)", () => {
  async function withMatch() {
    const s = await setup();
    const matchId = await s.t.mutation(api.agent.findRobots, { requestId: s.requestId });
    const start = (task: string) => s.raw.mutation(internal.discovery.start, { task, searchPhrase: task, matchId });
    const searches = () => s.raw.run((ctx) => ctx.db.query("discoveries").collect());
    return { ...s, start, searches };
  }

  it("is blocked unless DISCOVERY_ENABLED=true and APIFY_TOKEN are both set", async () => {
    const { start, searches, scheduled } = await withMatch();
    expect(await start("mowing")).toBe("blocked");
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    expect(await start("mowing")).toBe("blocked"); // still no Apify token
    vi.stubEnv("DISCOVERY_ENABLED", "false");
    vi.stubEnv("APIFY_TOKEN", "test-apify-token");
    expect(await start("mowing")).toBe("blocked");
    expect(await searches()).toEqual([]);
    expect(await scheduled()).toHaveLength(1); // only the match job
  });

  it("charges each new search to the request's owner and stops at the per-account limit", async () => {
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    vi.stubEnv("APIFY_TOKEN", "test-apify-token");
    const { start, searches, usage } = await withMatch();
    expect(await start("mowing")).toBe("run");
    expect(await start("edging")).toBe("blocked"); // DISCOVERY_USER_DAILY_LIMIT defaults to 1
    expect((await searches()).map((d) => d.task)).toEqual(["mowing"]);
    const owner = (await usage()).find((u) => u.kind === "match")!.userId;
    expect((await usage()).filter((u) => u.kind === "discovery").map((u) => u.userId)).toEqual([owner]);
  });

  it("forTask is for Clients only", async () => {
    const { raw, t } = await setup();
    await expect(raw.query(api.discovery.forTask, { task: "mowing" })).rejects.toThrow(/Please sign in/);
    await expect((await asDeveloper(raw)).query(api.discovery.forTask, { task: "mowing" })).rejects.toThrow(/needs a Client account/);
    expect(await t.query(api.discovery.forTask, { task: "mowing" })).toBeNull();
  });
});

describe("workflow breakdown (agent:planWorkflow and friends)", () => {
  const step = { name: "Mow the lawns", sharePct: 60, aiVerdict: "automatable" as const, why: "Fixture.", task: "mowing", searchPhrase: "robotic mower" };
  async function withReadyWorkflow() {
    const s = await setup();
    await s.raw.run((ctx) => ctx.db.insert("workflows", {
      requestId: s.requestId, status: "ready", steps: [step], laborCost: 50000, budget: null, requirements: [],
    }));
    return s;
  }

  it("anonymous callers, other Clients and Developers can't plan, read, change or search a breakdown", async () => {
    const { raw, requestId, usage, matches, scheduled } = await withReadyWorkflow();
    const callers: [any, RegExp][] = [
      [raw, /Please sign in/],
      [await asClient(raw, "user_client_b"), /Draft not found/],
      [await asDeveloper(raw), /needs a Client account/],
    ];
    for (const [c, err] of callers) {
      await expect(c.mutation(api.agent.planWorkflow, { requestId })).rejects.toThrow(err);
      await expect(c.query(api.agent.latestWorkflow, { requestId })).rejects.toThrow(err);
      await expect(c.mutation(api.agent.setStepShare, { requestId, step: 0, sharePct: 10 })).rejects.toThrow(err);
      await expect(c.mutation(api.agent.setWorkflowLabor, { requestId, laborCost: 1 })).rejects.toThrow(err);
      await expect(c.mutation(api.agent.checkStep, { requestId, step: 0 })).rejects.toThrow(err);
    }
    const wf = await raw.run((ctx) => ctx.db.query("workflows").first());
    expect(wf).toMatchObject({ laborCost: 50000, steps: [{ sharePct: 60 }] }); // unchanged
    expect(await usage()).toEqual([]);
    expect(await matches()).toEqual([]);
    expect(await scheduled()).toEqual([]);
  });

  it("the paid calls are off unless AI_MATCH_ENABLED=true; the free re-rank still works for the owner", async () => {
    const s = await setup({ enabled: false });
    await expect(s.t.mutation(api.agent.planWorkflow, { requestId: s.requestId })).rejects.toThrow(/turned off/);
    await s.raw.run((ctx) => ctx.db.insert("workflows", {
      requestId: s.requestId, status: "ready", steps: [step], laborCost: 50000, budget: null, requirements: [],
    }));
    await expect(s.t.mutation(api.agent.checkStep, { requestId: s.requestId, step: 0 })).rejects.toThrow(/turned off/);
    await s.t.mutation(api.agent.setStepShare, { requestId: s.requestId, step: 0, sharePct: 40 });
    expect((await s.raw.run((ctx) => ctx.db.query("workflows").first()))!.steps[0].sharePct).toBe(40);
    expect(await s.usage()).toEqual([]);
    expect(await s.scheduled()).toEqual([]);
  });

  it("a breakdown spends one AI budget unit, and the per-request limit stops the next one before anything runs", async () => {
    vi.stubEnv("AI_REQUEST_DAILY_LIMIT", "1");
    const { raw, t, requestId, usage, scheduled } = await setup();
    await t.mutation(api.agent.planWorkflow, { requestId });
    expect((await usage()).map((u) => u.kind)).toEqual(["match"]);
    await raw.run(async (ctx) => { for (const w of await ctx.db.query("workflows").collect()) await ctx.db.patch(w._id, { status: "ready", steps: [step] }); });
    await expect(t.mutation(api.agent.planWorkflow, { requestId })).rejects.toThrow(/reached its AI limit/);
    await expect(t.mutation(api.agent.checkStep, { requestId, step: 0 })).rejects.toThrow(/reached its AI limit/);
    expect(await scheduled()).toHaveLength(1); // only the first breakdown's split job
  });
});


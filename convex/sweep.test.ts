/// <reference types="vite/client" />
// The stuck-work sweeper (sweep.ts): nothing the page polls may stay "in progress" forever.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");
const MIN = 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-25T05:00:00Z"));
  const raw = convexTest(schema, modules);
  const t = await asClient(raw);
  const requestId = await t.mutation(api.requests.create, {
    title: "Fictional sweep test", description: "Fictional: we mow lawns.", environment: "Lawn care.", constraints: [],
  });
  return { raw, t, requestId };
}

describe("sweepStuck", () => {
  it("fails a search that ran too long and re-runs the matches waiting on it", async () => {
    const { raw, requestId } = await setup();
    const matchId = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "searching", picks: [] }));
    const discoveryId = await raw.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "robot mower", status: "crawling", urls: [], robotsFound: 0, waitingMatches: [matchId],
    }));
    vi.setSystemTime(Date.now() + 10 * MIN);
    expect(await raw.mutation(internal.sweep.sweepStuck, {})).toEqual({ searches: 0, matches: 0, workflows: 0 });
    vi.setSystemTime(Date.now() + 6 * MIN);
    expect((await raw.mutation(internal.sweep.sweepStuck, {})).searches).toBe(1);
    const d = (await raw.run((ctx) => ctx.db.get(discoveryId)))!;
    expect(d).toMatchObject({ status: "failed", waitingMatches: [] });
    const m = (await raw.run((ctx) => ctx.db.get(matchId)))!;
    expect(m.searchNote).toMatch(/^Web search failed: the search took too long/);
    const scheduled = await raw.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((f) => f.name.includes("matchRobots"))).toBe(true);
  });

  it("ends matches and breakdowns that crashed, keeping robots already ranked", async () => {
    const { raw, requestId } = await setup();
    const robotId = await raw.run((ctx) => ctx.db.insert("robots", {
      name: "Fictional Mower", vendor: "V", task: "mowing", price: 1, yearlyOpex: 0, automationShare: 0.5, environments: [], url: "https://example.com", sample: false,
    }));
    const pick = { robotId, score: 50, fit: [], paybackMonths: null, yearlyNetSavings: null, breakEvenAnnualCost: null, assumptions: [] };
    const reading = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "reading", picks: [] }));
    const ranked = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "ranked", picks: [pick] }));
    const waiting = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "searching", picks: [] }));
    const wf = await raw.run((ctx) => ctx.db.insert("workflows", { requestId, status: "splitting", steps: [], laborCost: null, budget: null, requirements: [] }));
    vi.setSystemTime(Date.now() + 11 * MIN);
    expect(await raw.mutation(internal.sweep.sweepStuck, {})).toEqual({ searches: 0, matches: 2, workflows: 1 });
    const get = (id: any) => raw.run((ctx) => ctx.db.get(id));
    expect(await get(reading)).toMatchObject({ status: "failed", error: "This took too long. Try again." });
    expect(await get(ranked)).toMatchObject({ status: "done", picks: [pick] });
    expect(await get(waiting)).toMatchObject({ status: "searching" }); // still inside its search window
    expect(await get(wf)).toMatchObject({ status: "failed" });
    vi.setSystemTime(Date.now() + 10 * MIN);
    await raw.mutation(internal.sweep.sweepStuck, {});
    expect(await get(waiting)).toMatchObject({ status: "done", searchNote: "Web search failed: it took too long. Try again." });
  });
});

describe("restarting a stuck search", () => {
  it("keeps the matches that were waiting on the old one", async () => {
    const { raw, requestId } = await setup();
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    vi.stubEnv("APIFY_TOKEN", "test-token-not-real");
    vi.stubEnv("DISCOVERY_DAILY_LIMIT", "100");
    vi.stubEnv("DISCOVERY_USER_DAILY_LIMIT", "100");
    vi.stubEnv("AI_DAILY_LIMIT", "100");
    vi.stubEnv("AI_USER_DAILY_LIMIT", "100");
    vi.stubEnv("AI_REQUEST_DAILY_LIMIT", "100");
    const first = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "searching", picks: [] }));
    const second = await raw.run((ctx) => ctx.db.insert("matches", { requestId, status: "searching", picks: [] }));
    await raw.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "x", status: "crawling", urls: [], robotsFound: 0, waitingMatches: [first],
    }));
    vi.setSystemTime(Date.now() + 16 * MIN);
    expect(await raw.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x", matchId: second })).toBe("run");
    const all = await raw.run((ctx) => ctx.db.query("discoveries").collect());
    expect(all).toHaveLength(1);
    expect(all[0].waitingMatches).toEqual([first, second]);
  });
});

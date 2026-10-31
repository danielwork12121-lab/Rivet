/// <reference types="vite/client" />
// Runs the real matchRobots and extractPages actions with the SDK's HTTP transport
// stubbed: no network, no cost. Every "model output" here is a hand-written TEST
// FIXTURE, used only to check what the code does with a well-formed response.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");
const token = "match-test-token-01";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const message = (model: string, output: unknown) =>
  new Response(JSON.stringify({
    id: "msg_test", type: "message", role: "assistant", model,
    content: [{ type: "text", text: JSON.stringify(output) }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });

// Answers like Haiku for the fast steps and like Opus for the reasons.
function stubClaude(fast: unknown, deep: unknown = { reasons: [] }) {
  const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return body.model === "claude-haiku-5-5" ? message(body.model, fast) : message(body.model, deep);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const intentFixture = { // TEST FIXTURE
  task: "Mowing", searchPhrase: "commercial robotic mower", annualTaskCost: 90000, budget: null,
  requirements: [{ name: "max_slope_deg", op: "atLeast", value: 25, unit: "degrees", mandatory: true }],
};

// Runs as a signed-in Client who owns the request, with AI matching switched on (it is off
// by default). Security behaviour (accounts, switches, budgets) is tested in agentSecurity.test.ts.
async function setup() {
  const raw = convexTest(schema, modules);
  const t = await asClient(raw);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.stubEnv("AI_MATCH_ENABLED", "true");
  const requestId = await t.mutation(api.requests.create, {
    title: "Fictional Hill Lawns — mowing",
    description: "Fictional: we mow steep lawns, slopes up to 25 degrees, and mowing costs about $90,000 a year.",
    environment: "Lawn care, West region.", constraints: [], clientToken: token,
  });
  vi.useFakeTimers(); // scheduled functions stay queued; each test runs what it needs
  const matchId = await t.mutation(api.agent.findRobots, { requestId });
  vi.useRealTimers();
  const latest = () => t.query(api.agent.latestMatch, { requestId });
  return { raw, t, requestId, matchId, latest };
}

async function addRobot(t: { run: ReturnType<typeof convexTest>["run"] }, name: string, slope: number, sample = false) {
  return await t.run((ctx) => ctx.db.insert("robots", {
    name, vendor: "Fictional Vendor", task: "mowing", price: 40000, yearlyOpex: 3000, automationShare: 0.6,
    environments: [], url: `https://example.com/${name}`, sample,
    specs: [{ name: "max_slope_deg", value: slope, quote: `Handles ${slope}° slopes.`, sourceUrl: "https://example.com" }],
  }));
}

describe("findRobots", () => {
  it("rejects another account, even one holding the old token; and Developers", async () => {
    const { raw, requestId } = await setup();
    const other = await asClient(raw, "user_client_b");
    await expect(other.mutation(api.agent.findRobots, { requestId, clientToken: token })).rejects.toThrow(/Draft not found/);
    const dev = await asDeveloper(raw);
    await expect(dev.mutation(api.agent.findRobots, { requestId })).rejects.toThrow(/needs a Client account/);
  });
});

describe("matchRobots (real action, stubbed transport)", () => {
  it("ranks catalog robots by code and adds Claude's reasons", async () => {
    const { t, matchId, latest } = await setup();
    const slope = await addRobot(t, "slope-mower", 30);
    await addRobot(t, "flat-mower", 15);
    const spy = stubClaude(intentFixture, { reasons: [{ robotId: slope, reason: "Handles your 25 degree hills and pays back in 9 months." }] });

    await t.action(internal.ai.matchRobots, { matchId });

    const m = (await latest())!;
    expect(m.status).toBe("done");
    expect(m.intent).toMatchObject({ task: "mowing", annualTaskCost: 90000 });
    expect(m.picks.map((p) => p.name)).toEqual(["slope-mower", "flat-mower"]);
    expect(m.picks[0]).toMatchObject({ paybackMonths: 9, reason: expect.stringContaining("9 months") });
    expect(m.next).toEqual({ kind: "show_matches" });
    expect(spy).toHaveBeenCalledTimes(2); // one fast read, one deep explanation
  });

  it("drops a reason that contains a number the code didn't produce", async () => {
    const { t, matchId, latest } = await setup();
    const slope = await addRobot(t, "slope-mower", 30);
    stubClaude(intentFixture, { reasons: [{ robotId: slope, reason: "Pays back in 4 months." }] });
    await t.action(internal.ai.matchRobots, { matchId });
    expect((await latest())!.picks[0].reason).toBeUndefined();
  });

  it("starts a web search when the catalog has only sample robots, then finishes after it", async () => {
    const { t, matchId, latest } = await setup();
    await addRobot(t, "sample-mower", 30, true);
    vi.stubEnv("APIFY_TOKEN", "test-apify-token");
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    stubClaude(intentFixture);
    vi.useFakeTimers(); // keep the scheduled Apify call from running
    await t.action(internal.ai.matchRobots, { matchId });
    let m = (await latest())!;
    expect(m.status).toBe("searching");
    expect(m.search).toMatchObject({ status: "searching" });

    // The search ends (normally after Apify + extraction): the match is re-run.
    const discovery = await t.run((ctx) => ctx.db.query("discoveries").first());
    expect(discovery).toMatchObject({ task: "mowing", searchPhrase: "commercial robotic mower", waitingMatches: [matchId] });
    await t.mutation(internal.discovery.finish, { discoveryId: discovery!._id, status: "done", robotsFound: 0 });
    const queued = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued.map((f) => f.name)).toContain("ai:matchRobots");
    vi.useRealTimers();

    await t.action(internal.ai.matchRobots, { matchId, searched: true });
    m = (await latest())!;
    expect(m.status).toBe("done");
    expect(m.picks).toEqual([]); // fictional robots are never shown
  });

  it("asks a second operator with the same task to wait for the same search", async () => {
    const { t, matchId } = await setup();
    vi.stubEnv("APIFY_TOKEN", "test-apify-token");
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    stubClaude(intentFixture);
    vi.useFakeTimers();
    await t.action(internal.ai.matchRobots, { matchId });
    const result = await t.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x" });
    expect(result).toBe("wait");
    expect(await t.run((ctx) => ctx.db.query("discoveries").collect())).toHaveLength(1);
  });

  it("retries a search that failed or found nothing, but not one that found robots", async () => {
    const { t } = await setup();
    vi.stubEnv("APIFY_TOKEN", "test-apify-token");
    vi.stubEnv("DISCOVERY_ENABLED", "true");
    vi.useFakeTimers();
    const insert = (status: "done" | "failed", robotsFound: number) =>
      t.run((ctx) => ctx.db.insert("discoveries", {
        task: "mowing", searchPhrase: "x", status, urls: [], robotsFound, waitingMatches: [], finishedAt: Date.now(),
      }));
    const clear = () => t.run(async (ctx) => {
      for (const d of await ctx.db.query("discoveries").collect()) await ctx.db.delete(d._id);
    });
    await insert("failed", 0);
    expect(await t.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x" })).toBe("run");
    await clear();
    await insert("done", 0);
    expect(await t.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x" })).toBe("run");
    await clear();
    // Its robots were since filed under another task name: nothing to show, so search again.
    await insert("done", 3);
    expect(await t.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x" })).toBe("run");
    await clear();
    await insert("done", 3);
    await addRobot(t, "found-mower", 30);
    expect(await t.mutation(internal.discovery.start, { task: "mowing", searchPhrase: "x" })).toBe("done");
  });

  it("tells the match why the web search was skipped", async () => {
    const { t, matchId, latest } = await setup();
    stubClaude(intentFixture);
    await t.action(internal.ai.matchRobots, { matchId }); // DISCOVERY_ENABLED is not set
    const note = (await latest())!.searchNote!;
    expect(note).toBe("Web search is off for this deployment; results come from Rivet's catalog.");
    expect(note).not.toMatch(/DISCOVERY_ENABLED|APIFY_TOKEN|\bset\b|backend/);
  });

  it("suggests a bounty listing the gap when no robot meets a must-have", async () => {
    const { t, matchId, latest } = await setup();
    await addRobot(t, "flat-mower", 15);
    stubClaude(intentFixture);
    await t.action(internal.ai.matchRobots, { matchId });
    expect((await latest())!.next).toEqual({ kind: "suggest_bounty", gaps: ["Max slope (degrees) at least 25"] });
  });

  it("on a model error, marks the match failed with a safe message", async () => {
    const { t, matchId, latest } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "internal detail" } }),
      { status: 400, headers: { "content-type": "application/json" } })));
    await t.action(internal.ai.matchRobots, { matchId });
    const m = (await latest())!;
    expect(m.status).toBe("failed");
    expect(m.error).not.toContain("internal detail");
  });
});

describe("extractPages (real action, stubbed transport)", () => {
  it("adds verified robots from crawled pages and finishes the search", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    const discoveryId = await t.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "robot mower", status: "extracting", urls: [], robotsFound: 0, waitingMatches: [],
    }));
    await t.mutation(internal.discovery.savePage, {
      discoveryId, url: "https://vendor.example/x1", title: "X1",
      markdown: "TurfBot X1 is a fictional robot mower. It costs $18,500 and climbs slopes up to 30 degrees. ".repeat(3) +
        "![TurfBot X1](https://vendor.example/img/x1.jpg)",
      imageUrl: "https://vendor.example/og.jpg",
    });
    stubClaude({ // TEST FIXTURE
      isRobotProduct: true, name: "TurfBot X1", vendor: "Fictional Vendor", priceOnRequest: false,
      price: { value: 18500, unit: "USD", quote: "It costs $18,500 and climbs slopes up to 30 degrees." },
      yearlyRunningCost: { value: null, unit: null, quote: null },
      laborSavedPercent: { value: null, unit: null, quote: null },
      specs: [{ name: "max_slope_deg", value: 30, unit: "degrees", quote: "climbs slopes up to 30 degrees" }],
      environments: ["outdoor"],
      imageUrl: "https://vendor.example/img/x1.jpg",
    });
    vi.useFakeTimers();
    await t.action(internal.ai.extractPages, { discoveryId });
    const robots = await t.run((ctx) => ctx.db.query("robots").collect());
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatchObject({ name: "TurfBot X1", price: 18500, priceStatus: "listed", sample: false, task: "mowing" });
    expect(robots[0].specs).toEqual([
      { name: "max_slope_deg", value: 30, quote: "climbs slopes up to 30 degrees", sourceUrl: "https://vendor.example/x1" },
    ]);
    expect(robots[0].assumptions).toHaveLength(2);
    expect(robots[0].imageUrl).toBe("https://vendor.example/img/x1.jpg"); // linked in the page, so kept
    expect(await t.run((ctx) => ctx.db.get(discoveryId))).toMatchObject({ status: "done", robotsFound: 1 });
  });
});

describe("discovery.finish", () => {
  it("tells waiting matches that the search failed, hiding an internal reason", async () => {
    const { t, matchId, latest } = await setup();
    const discoveryId = await t.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "x", status: "crawling", urls: [], robotsFound: 0, waitingMatches: [matchId],
    }));
    vi.useFakeTimers();
    await t.mutation(internal.discovery.finish, { discoveryId, status: "failed", robotsFound: 0, error: "Apify POST /acts/x/runs failed: 400 invalid input" });
    expect((await latest())!.searchNote).toBe("Web search didn't work this time; results come from Rivet's catalog. Try again later.");
  });

  it("never passes an env var name from a failed search on to the match", async () => {
    const { t, matchId, latest } = await setup();
    const discoveryId = await t.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "x", status: "crawling", urls: [], robotsFound: 0, waitingMatches: [matchId],
    }));
    vi.useFakeTimers();
    await t.mutation(internal.discovery.finish, { discoveryId, status: "failed", robotsFound: 0, error: "Error: APIFY_TOKEN is not set in Convex" });
    expect((await latest())!.searchNote).not.toMatch(/APIFY|TOKEN|Convex/);
  });
});

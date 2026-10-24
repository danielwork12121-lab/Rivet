/// <reference types="vite/client" />
// Runs the real scrape actions against a stubbed Apify API: no network, no cost.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Robot Spec Finder runs", () => {
  it("starts the Actor, then saves its robots when the run succeeds", async () => {
    vi.stubEnv("APIFY_TOKEN", "tok");
    vi.stubEnv("APIFY_ACTOR_ID", "trevor/robot-spec-finder");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const urls: string[] = [];
    let status = "RUNNING";
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/acts/")) return json({ data: { id: "run1", status, defaultDatasetId: "ds1" } });
      if (url.includes("/actor-runs/")) return json({ data: { id: "run1", status, defaultDatasetId: "ds1" } });
      return json([{ // TEST FIXTURE: one dataset row in the Actor's format
        name: "Mower X", vendor: "Acme", url: "https://acme.example/x", pricingModel: "purchase",
        purchasePriceUsd: 30000, yearlyCostToRunUsd: 3000, laborReplacedPercent: 60, environments: "outdoor", specs: [],
      }]);
    });
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const discoveryId = await t.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "commercial robotic mower", status: "searching", urls: [], robotsFound: 0, waitingMatches: [],
    }));
    await t.action(internal.scrape.discover, { discoveryId });
    expect(urls[0]).toBe("https://api.apify.com/v2/acts/trevor~robot-spec-finder/runs");
    expect((await t.run((ctx) => ctx.db.get(discoveryId)))?.status).toBe("crawling");

    status = "SUCCEEDED";
    await t.action(internal.scrape.checkFinderRun, { discoveryId, runId: "run1", startedAt: Date.now() });
    expect(await t.run((ctx) => ctx.db.get(discoveryId))).toMatchObject({ status: "done", robotsFound: 1 });
    const robots = await t.run((ctx) => ctx.db.query("robots").collect());
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatchObject({ name: "Mower X", price: 30000, sample: false, task: "mowing" });
  });
});

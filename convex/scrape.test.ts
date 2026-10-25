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

  // The Anthropic key must stay in Convex: Apify stores and shows every run's input.
  const SENTINEL = "sk-ant-TEST-SENTINEL-do-not-leak";
  function recordingApify(datasetRows: unknown[], runStatus = "SUCCEEDED") {
    const sent: { url: string; method: string; body: string; headers: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? "GET", body: String(init.body ?? ""), headers: JSON.stringify(init.headers ?? {}) });
      if (!url.startsWith("https://api.apify.com/")) throw new Error(`unexpected request to ${url}`);
      if (url.includes("/acts/") || url.includes("/actor-runs/")) return json({ data: { id: "run1", status: runStatus, defaultDatasetId: "ds1" } });
      return json(datasetRows);
    });
    return sent;
  }
  const page = (url: string) => ({ url, title: "Acme X1", markdown: "# Acme X1 robotic mower\n" + "It mows steep slopes. ".repeat(20) });
  async function newSearch(t: ReturnType<typeof convexTest>) {
    return await t.run((ctx) => ctx.db.insert("discoveries", {
      task: "mowing", searchPhrase: "commercial robotic mower", status: "searching", urls: [], robotsFound: 0, waitingMatches: [],
    }));
  }

  it("starts the Actor in crawlOnly mode and puts no credential in its input", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify-test-token");
    vi.stubEnv("APIFY_ACTOR_ID", "trevor/robot-spec-finder");
    vi.stubEnv("ANTHROPIC_API_KEY", SENTINEL);
    const sent = recordingApify([], "RUNNING");
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.action(internal.scrape.discover, { discoveryId: await newSearch(t) });
    const start = sent.find((r) => r.url.includes("/acts/"))!;
    expect(JSON.parse(start.body)).toEqual({ task: "mowing", searchPhrase: "commercial robotic mower", crawlOnly: true, maxSites: 8 });
    // The sentinel appears in no URL, header or body of anything sent to Apify.
    expect(sent.some((r) => (r.url + r.body + r.headers).includes(SENTINEL))).toBe(false);
  });

  it("saves the pages an Actor run returns and leaves reading them to Convex's own Claude step", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify-test-token");
    vi.stubEnv("APIFY_ACTOR_ID", "trevor/robot-spec-finder");
    vi.stubEnv("ANTHROPIC_API_KEY", SENTINEL);
    const sent = recordingApify([page("https://acme.example/x1"), { url: "https://blocked.example", title: "", markdown: "403" }]);
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const discoveryId = await newSearch(t);
    await t.action(internal.scrape.checkFinderRun, { discoveryId, runId: "run1", startedAt: Date.now() });
    const pages = await t.run((ctx) => ctx.db.query("pages").collect());
    expect(pages.map((p) => p.url)).toEqual(["https://acme.example/x1"]); // the blocked page is dropped
    expect(pages[0]).toMatchObject({ discoveryId, extracted: false, title: "Acme X1" });
    expect((await t.run((ctx) => ctx.db.get(discoveryId)))?.status).toBe("extracting");
    const queued = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued.map((q) => q.name)).toContain("ai:extractPages");
    expect(sent.every((r) => r.url.startsWith("https://api.apify.com/"))).toBe(true); // nothing went to an AI provider
    expect(sent.some((r) => (r.url + r.body + r.headers).includes(SENTINEL))).toBe(false);
  });

  it("finishes with no robots when the run returned no usable pages", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify-test-token");
    recordingApify([{ url: "https://blocked.example", title: "", markdown: "403" }]);
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const discoveryId = await newSearch(t);
    await t.action(internal.scrape.checkFinderRun, { discoveryId, runId: "run1", startedAt: Date.now() });
    expect(await t.run((ctx) => ctx.db.get(discoveryId))).toMatchObject({ status: "done", robotsFound: 0 });
    expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual([]);
  });

  it("falls back to the built-in search when Apify refuses to start the finder Actor", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify-test-token");
    vi.stubEnv("APIFY_ACTOR_ID", "trevor/robot-spec-finder");
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(url);
      if (url.includes("trevor~robot-spec-finder")) {
        return new Response(JSON.stringify({ error: { type: "invalid-input", message: "Field input.anthropicApiKey is required" } }), { status: 400 });
      }
      if (url.includes("/acts/") || url.includes("/actor-runs/")) return json({ data: { id: "run2", status: "SUCCEEDED", defaultDatasetId: "ds1" } });
      return json([{ organicResults: [{ url: "https://acme.example/x1" }] }]);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const discoveryId = await newSearch(t);
    await t.action(internal.scrape.discover, { discoveryId });
    expect(sent.some((u) => u.includes("apify~google-search-scraper"))).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(discoveryId)))?.status).not.toBe("failed");
  });

  it("the built-in crawl path sends no credential either", async () => {
    vi.stubEnv("APIFY_TOKEN", "apify-test-token");
    vi.stubEnv("ANTHROPIC_API_KEY", SENTINEL);
    const sent = recordingApify([{ organicResults: [{ url: "https://acme.example/x1" }] }]);
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.action(internal.scrape.discover, { discoveryId: await newSearch(t) });
    expect(sent.filter((r) => r.url.includes("/runs")).length).toBeGreaterThan(0);
    expect(sent.some((r) => (r.url + r.body + r.headers).includes(SENTINEL))).toBe(false);
  });
});

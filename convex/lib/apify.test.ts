import { afterEach, describe, expect, it, vi } from "vitest";
import { callActor, datasetItems, startActor } from "./apify";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  return calls;
}

describe("apify REST client", () => {
  it("starts an actor by username/name with the token as a bearer header", async () => {
    vi.stubEnv("APIFY_TOKEN", "tok");
    const calls = stubFetch([{ data: { id: "r1", status: "RUNNING", defaultDatasetId: "d1" } }]);
    const run = await startActor("trevor/robot-spec-finder", { task: "mowing" });
    expect(run.id).toBe("r1");
    expect(calls[0].url).toBe("https://api.apify.com/v2/acts/trevor~robot-spec-finder/runs");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("waits for a run to finish", async () => {
    vi.stubEnv("APIFY_TOKEN", "tok");
    const calls = stubFetch([
      { data: { id: "r1", status: "RUNNING", defaultDatasetId: "d1" } },
      { data: { id: "r1", status: "SUCCEEDED", defaultDatasetId: "d1" } },
    ]);
    const run = await callActor("apify/google-search-scraper", {}, 120);
    expect(run.status).toBe("SUCCEEDED");
    expect(calls[1].url).toContain("/actor-runs/r1?waitForFinish=");
  });

  it("returns dataset items and explains HTTP errors", async () => {
    vi.stubEnv("APIFY_TOKEN", "tok");
    stubFetch([[{ name: "Mower" }]]);
    expect(await datasetItems("d1")).toEqual([{ name: "Mower" }]);
    vi.stubGlobal("fetch", async () => new Response("Actor not found", { status: 404 }));
    await expect(startActor("nobody/x", {})).rejects.toThrow(/404 Actor not found/);
  });

  it("says when the token is missing", async () => {
    vi.stubEnv("APIFY_TOKEN", "");
    await expect(datasetItems("d1")).rejects.toThrow(/APIFY_TOKEN/);
  });
});

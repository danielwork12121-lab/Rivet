/// <reference types="vite/client" />
// Runs the real extractSpec action with the SDK's HTTP transport stubbed: no network,
// no cost. The "model output" below is a hand-written TEST FIXTURE, used only here
// to check that a well-formed response is stored; the app never serves fixtures.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const token = "ai-test-token-0001";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setupJob() {
  const t = convexTest(schema, modules);
  const requestId = await t.mutation(api.requests.create, {
    title: "Fictional Lawn Co. — mowing", description: "Fictional: 3 crews mow 120 lawns a week.",
    environment: "Lawn care operation, West region.", constraints: [], clientToken: token,
  });
  // Queue a job the way the page does; the scheduled copy never runs (no timers advanced).
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.useFakeTimers();
  const { jobId } = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
  vi.useRealTimers();
  const status = () => t.query(api.agent.specStatus, { requestId, clientToken: token });
  const runs = () => t.run((ctx) => ctx.db.query("agentRuns").collect());
  return { t, requestId, jobId, status, runs };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });

describe("extractSpec (real action, stubbed transport)", () => {
  it("with no credentials: job fails as unavailable, nothing is stored, the run is logged", async () => {
    const { t, requestId, jobId, status, runs } = await setupJob();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(t.action(internal.ai.extractSpec, { requestId, jobId })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    const s = await status();
    expect(s.job).toMatchObject({ status: "failed", errorKind: "unavailable" });
    expect(s.job?.error).toMatch(/credentials are missing or were rejected/);
    expect(s.spec).toBeNull();
    const all = await runs();
    expect(all[all.length - 1]).toMatchObject({ route: "spec", ok: false });
  });

  it("with a rejected key (401): job fails as unavailable", async () => {
    const { t, requestId, jobId, status } = await setupJob();
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })));
    await expect(t.action(internal.ai.extractSpec, { requestId, jobId })).rejects.toThrow();
    expect((await status()).job).toMatchObject({ status: "failed", errorKind: "unavailable" });
  });

  it("with a request error (400): job fails as a model error with a safe message", async () => {
    const { t, requestId, jobId, status } = await setupJob();
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, { type: "error", error: { type: "invalid_request_error", message: "internal detail" } })));
    await expect(t.action(internal.ai.extractSpec, { requestId, jobId })).rejects.toThrow();
    const s = await status();
    expect(s.job).toMatchObject({ status: "failed", errorKind: "model_error" });
    expect(s.job?.error).not.toContain("internal detail");
  });

  it("with a well-formed response: stores the spec on the job, not stale, and never sends the token", async () => {
    const { t, requestId, jobId, status } = await setupJob();
    const fixture = { // TEST FIXTURE, not model output
      summary: "Fixture summary", tasks: ["mow lawns"], environmentFactors: [{ name: "terrain", value: "lawns" }],
      requirements: [{ kind: "performance", description: "Fixture requirement", value: null, unit: null, mandatory: true }],
      confidence: 1.4, followUpQuestions: ["q1", "q2", "q3", "q4"],
    };
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(200, {
      id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(fixture) }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await t.action(internal.ai.extractSpec, { requestId, jobId });

    const sent = String(fetchSpy.mock.calls[0][1]?.body);
    expect(sent).toContain("Fictional: 3 crews mow 120 lawns a week."); // the request did go to the model
    expect(sent).not.toContain(token);

    const s = await status();
    expect(s.job).toMatchObject({ status: "succeeded" });
    expect(s.stale).toBe(false);
    expect(s.spec).toMatchObject({
      jobId, source: "ai", status: "draft", model: "claude-opus-5-5", summary: "Fixture summary",
      confidence: 1, followUpQuestions: ["q1", "q2", "q3"],
    });
    expect(s.spec?.requirements[0]).not.toHaveProperty("value");
    expect((await t.query(api.requests.getDraft, { id: requestId, clientToken: token })).status).toBe("specified");
  });

  it("a second pickup of the same job does nothing (no second paid call)", async () => {
    const { t, requestId, jobId } = await setupJob();
    await t.mutation(internal.agent.markJobRunning, { jobId });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await t.action(internal.ai.extractSpec, { requestId, jobId });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

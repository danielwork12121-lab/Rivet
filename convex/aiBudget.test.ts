/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

// Paid AI actions are scheduled but never run here (fake timers are not advanced).
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.stubEnv("RIVET_SERVER_SECRET", "server-secret-for-tests");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const intake = {
  title: "E2E-TEST budget", description: "Fictional.", environment: "Lawn care operation.", constraints: [],
};
async function setup(n = 1) {
  const t = convexTest(schema, modules);
  const reqs = [];
  for (let i = 0; i < n; i++) {
    const clientToken = `budget-token-000${i}`;
    reqs.push({ requestId: await t.mutation(api.requests.create, { ...intake, clientToken }), clientToken });
  }
  const usage = () => t.run((ctx) => ctx.db.query("aiUsage").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { t, reqs, usage, scheduled };
}
// Each new spec run needs the previous one to have finished.
async function finishLatestJob(t: any, requestId: any) {
  const job = await t.run((ctx: any) =>
    ctx.db.query("aiJobs").withIndex("by_request_kind", (q: any) => q.eq("requestId", requestId)).order("desc").first());
  await t.mutation(internal.agent.finishJob, { jobId: job._id, status: "failed", errorKind: "model_error", error: "x" });
}
const key = (c: string) => c.repeat(32);

describe("AI budget: per request", () => {
  it("allows AI_REQUEST_DAILY_LIMIT spec runs per request, then refuses with a safe message", async () => {
    vi.stubEnv("AI_REQUEST_DAILY_LIMIT", "2");
    const { t, reqs: [r], usage, scheduled } = await setup();
    for (let i = 0; i < 2; i++) {
      await t.mutation(api.agent.generateSpec, r);
      await finishLatestJob(t, r.requestId);
    }
    await expect(t.mutation(api.agent.generateSpec, r)).rejects.toThrow(/This request has reached its AI limit/);
    expect(await usage()).toHaveLength(2);
    expect(await scheduled()).toHaveLength(2);
    const st = await t.query(api.agent.specStatus, r);
    expect(st).toMatchObject({ available: false, unavailableReason: "request_limit" });
  });

  it("reusing a run in progress spends nothing", async () => {
    const { t, reqs: [r], usage } = await setup();
    await t.mutation(api.agent.generateSpec, r);
    await t.mutation(api.agent.generateSpec, r);
    await t.mutation(api.agent.generateSpec, r);
    expect(await usage()).toHaveLength(1);
  });
});

describe("AI budget: global daily cap", () => {
  it("caps all paid AI kinds together and reports it in aiStatus", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const { t, reqs: [a, b], usage, scheduled } = await setup(2);
    await t.mutation(api.agent.generateSpec, a);
    await t.mutation(api.agent.recommend, b);
    await t.mutation(api.agent.requestBounty, { ...b, gap: "Needs to handle slopes" });
    expect(await usage()).toHaveLength(3);
    await expect(t.mutation(api.agent.generateSpec, b)).rejects.toThrow(/AI budget for today has been used up/);
    await expect(t.mutation(api.agent.recommend, a)).rejects.toThrow(/AI budget for today/);
    await expect(t.mutation(api.agent.requestBounty, { ...a, gap: "x" })).rejects.toThrow(/AI budget for today/);
    expect(await scheduled()).toHaveLength(3);
    expect(await t.query(api.agent.aiStatus, {})).toMatchObject({ available: false, reason: "daily_limit" });
  });

  it("answerQuestions keeps answers but starts nothing once the budget is used up", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "0");
    const { t, reqs: [r], scheduled } = await setup();
    expect(await t.mutation(api.agent.answerQuestions, { ...r, answers: [{ question: "Cost?", answer: "$40k" }] })).toBeNull();
    expect(await scheduled()).toHaveLength(0);
    expect((await t.query(api.agent.specStatus, r)).clarifications).toHaveLength(1);
  });

  it("frees up after 24 hours", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const { t, reqs: [a, b] } = await setup(2);
    await t.mutation(api.agent.generateSpec, a);
    await expect(t.mutation(api.agent.generateSpec, b)).rejects.toThrow(/used up/);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    await expect(t.mutation(api.agent.generateSpec, b)).resolves.toMatchObject({ reused: false });
  });

  it.each([["-1"], ["2.5"], ["lots"]])("a misconfigured limit (%s) fails closed", async (value) => {
    vi.stubEnv("AI_DAILY_LIMIT", value);
    const { t, reqs: [r], scheduled } = await setup();
    await expect(t.mutation(api.agent.generateSpec, r)).rejects.toThrow(/used up/);
    expect(await scheduled()).toHaveLength(0);
  });

  it("without a key, nothing is spent and the reason is no_key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { t, reqs: [r], usage } = await setup();
    await expect(t.mutation(api.agent.recommend, r)).rejects.toThrow(/no Anthropic API key/);
    await expect(t.mutation(api.agent.requestBounty, { ...r, gap: "x" })).rejects.toThrow(/no Anthropic API key/);
    expect(await usage()).toHaveLength(0);
  });
});

describe("aiBudget:reserveChat (Vercel /api/chat)", () => {
  it("requires the server secret; a wrong or missing secret spends nothing", async () => {
    const { t, usage } = await setup(0);
    await expect(t.mutation(api.aiBudget.reserveChat, { secret: "wrong", clientKey: key("a") })).rejects.toThrow(/forbidden/);
    vi.stubEnv("RIVET_SERVER_SECRET", "");
    await expect(t.mutation(api.aiBudget.reserveChat, { secret: "", clientKey: key("a") })).rejects.toThrow(/forbidden/);
    expect(await usage()).toHaveLength(0);
  });

  it("rejects a client key that isn't a hash", async () => {
    const { t } = await setup(0);
    await expect(
      t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: "203.0.113.7" }),
    ).rejects.toThrow(/invalid client key/);
  });

  it("enforces the per-visitor and global limits", async () => {
    vi.stubEnv("AI_CLIENT_DAILY_LIMIT", "2");
    vi.stubEnv("AI_DAILY_LIMIT", "3");
    const { t, usage } = await setup(0);
    const reserve = (c: string) => t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: key(c) });
    expect(await reserve("a")).toEqual({ ok: true });
    expect(await reserve("a")).toEqual({ ok: true });
    expect(await reserve("a")).toEqual({ ok: false, reason: "client_limit" });
    expect(await reserve("b")).toEqual({ ok: true });
    expect(await reserve("c")).toEqual({ ok: false, reason: "daily_limit" });
    expect(await usage()).toHaveLength(3);
  });

  it("chat and spec drafting share the global cap", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const { t, reqs: [r] } = await setup();
    expect(await t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: key("d") })).toEqual({ ok: true });
    await expect(t.mutation(api.agent.generateSpec, r)).rejects.toThrow(/used up/);
  });
});

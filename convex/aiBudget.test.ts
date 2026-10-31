/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper, signedIn } from "../tests/auth-helpers";

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
  const base = convexTest(schema, modules);
  const t = await asClient(base);
  const reqs = [];
  for (let i = 0; i < n; i++) {
    const clientToken = `budget-token-000${i}`;
    reqs.push({ requestId: await t.mutation(api.requests.create, { ...intake, clientToken }), clientToken });
  }
  const usage = () => t.run((ctx) => ctx.db.query("aiUsage").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { t, base, reqs, usage, scheduled };
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

describe("AI budget: per account", () => {
  it("AI_USER_DAILY_LIMIT caps one account across its requests", async () => {
    vi.stubEnv("AI_USER_DAILY_LIMIT", "2");
    const { t, base, reqs: [a, b, c], usage } = await setup(3);
    await t.mutation(api.agent.generateSpec, a);
    await t.mutation(api.agent.recommend, b);
    await expect(t.mutation(api.agent.generateSpec, c)).rejects.toThrow(/Your account has reached today's AI limit/);
    expect(await usage()).toHaveLength(2);
    // Another account still has its own allowance.
    const other = await asClient(base, "user_client_b");
    const id = await other.mutation(api.requests.create, { ...intake, clientToken: "budget-token-other" });
    await expect(other.mutation(api.agent.generateSpec, { requestId: id })).resolves.toMatchObject({ reused: false });
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

  it.each([["-1"], ["2.5"], ["lots"], ["2.5 \n"], ["  "]])("a misconfigured limit (%j) fails closed", async (value) => {
    vi.stubEnv("AI_DAILY_LIMIT", value);
    const { t, reqs: [r], scheduled } = await setup();
    await expect(t.mutation(api.agent.generateSpec, r)).rejects.toThrow(/used up/);
    expect(await scheduled()).toHaveLength(0);
  });

  it("ignores whitespace around a limit (pasted with a trailing newline)", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", " 1\n");
    const { t, reqs: [a, b] } = await setup(2);
    await expect(t.mutation(api.agent.generateSpec, a)).resolves.toMatchObject({ reused: false });
    await expect(t.mutation(api.agent.generateSpec, b)).rejects.toThrow(/used up/);
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

  it("ignores whitespace around the secret, stored or sent", async () => {
    vi.stubEnv("RIVET_SERVER_SECRET", "server-secret-for-tests\n");
    const { t, usage } = await setup(0);
    expect(await t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: key("a") })).toEqual({ ok: true });
    expect(await t.mutation(api.aiBudget.reserveChat, { secret: " server-secret-for-tests \n", clientKey: key("b") })).toEqual({ ok: true });
    vi.stubEnv("RIVET_SERVER_SECRET", " \n");
    await expect(t.mutation(api.aiBudget.reserveChat, { secret: " ", clientKey: key("c") })).rejects.toThrow(/forbidden/);
    expect(await usage()).toHaveLength(2);
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

  it("requires a signed-in Client account; others spend nothing", async () => {
    const { base, usage } = await setup(0);
    const args = { secret: "server-secret-for-tests", clientKey: key("e") };
    expect(await base.mutation(api.aiBudget.reserveChat, args)).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await signedIn(base, "user_new").mutation(api.aiBudget.reserveChat, args)).toEqual({ ok: false, reason: "no_account" });
    const dev = await asDeveloper(base);
    expect(await dev.mutation(api.aiBudget.reserveChat, args)).toEqual({ ok: false, reason: "not_client" });
    expect(await usage()).toHaveLength(0);
  });

  it("records the account and enforces the per-account limit across visitors", async () => {
    vi.stubEnv("AI_USER_DAILY_LIMIT", "2");
    const { t, usage } = await setup(0);
    const reserve = (c: string) => t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: key(c) });
    expect(await reserve("a")).toEqual({ ok: true });
    expect(await reserve("b")).toEqual({ ok: true });
    expect(await reserve("c")).toEqual({ ok: false, reason: "user_limit" });
    expect((await usage()).every((u) => u.userId)).toBe(true);
  });

  it("chat and spec drafting share the global cap", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "1");
    const { t, reqs: [r] } = await setup();
    expect(await t.mutation(api.aiBudget.reserveChat, { secret: "server-secret-for-tests", clientKey: key("d") })).toEqual({ ok: true });
    await expect(t.mutation(api.agent.generateSpec, r)).rejects.toThrow(/used up/);
  });
});

describe("aiBudget:reserveVideo (Vercel /api/analyze-video)", () => {
  const secret = "server-secret-for-tests";
  const video = (t: any, c: string) => t.mutation(api.aiBudget.reserveVideo, { secret, clientKey: key(c) });

  it("requires the server secret; a wrong or missing secret spends nothing", async () => {
    const { t, usage } = await setup(0);
    await expect(t.mutation(api.aiBudget.reserveVideo, { secret: "wrong", clientKey: key("a") })).rejects.toThrow(/forbidden/);
    vi.stubEnv("RIVET_SERVER_SECRET", "");
    await expect(t.mutation(api.aiBudget.reserveVideo, { secret: "", clientKey: key("a") })).rejects.toThrow(/forbidden/);
    expect(await usage()).toHaveLength(0);
  });

  it("requires a signed-in Client account; anonymous, no-account and Developer spend nothing", async () => {
    const { base, usage } = await setup(0);
    expect(await video(base, "a")).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await video(signedIn(base, "user_new"), "a")).toEqual({ ok: false, reason: "no_account" });
    expect(await video(await asDeveloper(base), "a")).toEqual({ ok: false, reason: "not_client" });
    expect(await usage()).toHaveLength(0);
  });

  it("records a video usage row for the account", async () => {
    const { t, usage } = await setup(0);
    expect(await video(t, "a")).toEqual({ ok: true });
    const [row] = await usage();
    expect(row).toMatchObject({ kind: "video", clientKey: key("a") });
    expect(row.userId).toBeTruthy();
  });

  it("enforces VIDEO_USER_DAILY_LIMIT per account across visitors, and other accounts keep their own", async () => {
    vi.stubEnv("VIDEO_USER_DAILY_LIMIT", "2");
    const { t, base, usage } = await setup(0);
    expect(await video(t, "a")).toEqual({ ok: true });
    expect(await video(t, "b")).toEqual({ ok: true });
    expect(await video(t, "c")).toEqual({ ok: false, reason: "video_user_limit" });
    const other = await asClient(base, "user_client_b");
    expect(await video(other, "d")).toEqual({ ok: true });
    expect(await usage()).toHaveLength(3);
  });

  it("enforces VIDEO_DAILY_LIMIT across all accounts", async () => {
    vi.stubEnv("VIDEO_DAILY_LIMIT", "2");
    const { t, base } = await setup(0);
    const other = await asClient(base, "user_client_b");
    expect(await video(t, "a")).toEqual({ ok: true });
    expect(await video(other, "b")).toEqual({ ok: true });
    expect(await video(t, "c")).toEqual({ ok: false, reason: "video_limit" });
    expect(await video(other, "d")).toEqual({ ok: false, reason: "video_limit" });
  });

  it("reservations are atomic: concurrent callers can't exceed the limit", async () => {
    vi.stubEnv("VIDEO_DAILY_LIMIT", "3");
    vi.stubEnv("VIDEO_USER_DAILY_LIMIT", "10");
    vi.stubEnv("AI_USER_DAILY_LIMIT", "100");
    const { t, usage } = await setup(0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => video(t, String(i))));
    expect(results.filter((r: any) => r.ok)).toHaveLength(3);
    expect(await usage()).toHaveLength(3);
  });

  it("video counts toward the all-kinds daily cap, and chat does not count toward video limits", async () => {
    vi.stubEnv("AI_DAILY_LIMIT", "2");
    const { t } = await setup(0);
    const chat = (c: string) => t.mutation(api.aiBudget.reserveChat, { secret, clientKey: key(c) });
    expect(await video(t, "a")).toEqual({ ok: true });
    expect(await chat("b")).toEqual({ ok: true });
    expect(await video(t, "c")).toEqual({ ok: false, reason: "daily_limit" });
    expect(await chat("d")).toEqual({ ok: false, reason: "daily_limit" });
  });

  it("a video limit of 0 turns video off without affecting chat", async () => {
    vi.stubEnv("VIDEO_DAILY_LIMIT", "0");
    const { t } = await setup(0);
    expect(await video(t, "a")).toEqual({ ok: false, reason: "video_limit" });
    expect(await t.mutation(api.aiBudget.reserveChat, { secret, clientKey: key("a") })).toEqual({ ok: true });
  });

  it("a misconfigured video limit fails closed", async () => {
    vi.stubEnv("VIDEO_USER_DAILY_LIMIT", "lots");
    const { t } = await setup(0);
    expect(await video(t, "a")).toEqual({ ok: false, reason: "video_user_limit" });
  });
});

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

// Scheduled AI actions are queued but never run here (fake timers are not advanced),
// so no test touches the Anthropic API.
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
// No key unless a test stubs one: the default, and the state of the local demo backend.
beforeEach(() => vi.stubEnv("ANTHROPIC_API_KEY", ""));

const token = "agent-test-token-1";
const intake = {
  title: "Fictional Lawn Co. — Lawn care automation request",
  description: "Fictional: we mow 50 lawns a week.",
  environment: "Lawn care operation, West region, 2 crews of 2 people.",
  constraints: [],
};

async function setup() {
  const t = convexTest(schema, modules);
  const requestId = await t.mutation(api.requests.create, { ...intake, clientToken: token });
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { t, requestId, scheduled };
}

describe("agent endpoints require the draft token", () => {
  const wrong = "not-the-owner-token";

  it.each([
    ["generateSpec", (t: any, id: any, clientToken: string) => t.mutation(api.agent.generateSpec, { requestId: id, clientToken })],
    ["answerQuestions", (t: any, id: any, clientToken: string) =>
      t.mutation(api.agent.answerQuestions, { requestId: id, clientToken, answers: [{ question: "Q?", answer: "A" }] })],
    ["recommend", (t: any, id: any, clientToken: string) => t.mutation(api.agent.recommend, { requestId: id, clientToken })],
    ["requestBounty", (t: any, id: any, clientToken: string) =>
      t.mutation(api.agent.requestBounty, { requestId: id, clientToken, gap: "Needs to handle slopes" })],
    ["latestSpec", (t: any, id: any, clientToken: string) => t.query(api.agent.latestSpec, { requestId: id, clientToken })],
    ["latestPicks", (t: any, id: any, clientToken: string) => t.query(api.agent.latestPicks, { requestId: id, clientToken })],
    ["latestBounty", (t: any, id: any, clientToken: string) => t.query(api.agent.latestBounty, { requestId: id, clientToken })],
  ])("%s rejects a wrong token and schedules or writes nothing", async (_name, call) => {
    const { t, requestId, scheduled } = await setup();
    await expect(call(t, requestId, wrong)).rejects.toThrow(/Draft not found/);
    expect(await scheduled()).toHaveLength(0);
    const clarifications = await t.run((ctx) => ctx.db.query("clarifications").collect());
    expect(clarifications).toHaveLength(0);
  });

  it("generateSpec with the right token schedules exactly one spec extraction", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    const { t, requestId, scheduled } = await setup();
    await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    const jobs = await scheduled();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("extractSpec");
    expect(await t.query(api.agent.latestSpec, { requestId, clientToken: token })).toBeNull();
  });

  it("answerQuestions stores trimmed answers, skips blanks and validates length", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.agent.answerQuestions, {
      requestId, clientToken: token,
      answers: [{ question: " What does the task cost per year? ", answer: " About $40,000 " }, { question: "Skipped?", answer: "  " }],
    });
    const rows = await t.run((ctx) => ctx.db.query("clarifications").collect());
    expect(rows.map((r) => [r.question, r.answer])).toEqual([["What does the task cost per year?", "About $40,000"]]);
    await expect(
      t.mutation(api.agent.answerQuestions, { requestId, clientToken: token, answers: [{ question: "Q", answer: "x".repeat(1001) }] }),
    ).rejects.toThrow(/answer must be 1-1000 characters/);
  });

  it("rejects a blank bounty gap and a negative max price", async () => {
    const { t, requestId, scheduled } = await setup();
    await expect(
      t.mutation(api.agent.requestBounty, { requestId, clientToken: token, gap: "   " }),
    ).rejects.toThrow(/gap must be/);
    await expect(
      t.mutation(api.agent.recommend, { requestId, clientToken: token, maxPrice: -1 }),
    ).rejects.toThrow(/maxPrice must be/);
    expect(await scheduled()).toHaveLength(0);
  });
});

describe("what the agent sends to Claude", () => {
  it("requestContext never includes the draft token", async () => {
    const { t, requestId } = await setup();
    const context = await t.query(internal.agent.requestContext, { requestId });
    expect(context.request).not.toHaveProperty("clientToken");
    expect(JSON.stringify(context)).not.toContain(token);
    expect(context.request.description).toBe(intake.description);
  });
});

describe("AI job lifecycle", () => {
  const withKey = () => vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  const specFields = {
    model: "test-fixture", summary: "s", tasks: ["mow"], environmentFactors: [],
    requirements: [], confidence: 0.5, followUpQuestions: ["What does mowing cost you per year?"],
  };

  it("without a key: generateSpec is refused as unavailable and nothing is queued", async () => {
    const { t, requestId, scheduled } = await setup();
    await expect(t.mutation(api.agent.generateSpec, { requestId, clientToken: token })).rejects.toThrow(
      /AI drafting is unavailable/,
    );
    expect(await scheduled()).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("aiJobs").collect())).toHaveLength(0);
    expect(await t.query(api.agent.aiStatus, {})).toEqual({
      available: false, reason: "no_key", message: expect.stringMatching(/AI drafting is unavailable/),
    });
    const status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status).toMatchObject({ available: false, job: null, spec: null, stale: false });
  });

  it("answerQuestions without a key keeps the answers and queues nothing", async () => {
    const { t, requestId, scheduled } = await setup();
    const r = await t.mutation(api.agent.answerQuestions, {
      requestId, clientToken: token, answers: [{ question: "Cost?", answer: "About $40,000" }],
    });
    expect(r).toBeNull();
    expect(await scheduled()).toHaveLength(0);
    const status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status.clarifications).toEqual([{ question: "Cost?", answer: "About $40,000" }]);
  });

  it("repeated clicks reuse the queued job: one job, one scheduled call", async () => {
    withKey();
    const { t, requestId, scheduled } = await setup();
    const a = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    const b = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    expect(a.reused).toBe(false);
    expect(b).toEqual({ jobId: a.jobId, reused: true });
    expect(await scheduled()).toHaveLength(1);
    const status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status.job?.status).toBe("queued");
  });

  it("queued -> running -> succeeded, then becomes stale when the request changes", async () => {
    withKey();
    const { t, requestId } = await setup();
    const { jobId } = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    expect(await t.mutation(internal.agent.markJobRunning, { jobId })).toBe(true);
    expect(await t.mutation(internal.agent.markJobRunning, { jobId })).toBe(false); // second pickup refused
    const draft = await t.query(api.requests.getDraft, { id: requestId, clientToken: token });
    const specId = await t.mutation(internal.agent.saveSpec, {
      requestId, ...specFields, jobId, requestVersion: draft.updatedAt ?? draft._creationTime,
    });
    await t.mutation(internal.agent.finishJob, { jobId, status: "succeeded", specId });
    let status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status).toMatchObject({ job: { status: "succeeded" }, stale: false });
    expect(status.spec?._id).toBe(specId);

    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(api.requests.saveFollowUps, {
      id: requestId, clientToken: token, complete: false,
      answers: [{ key: "slope", question: "Slopes?", answerLabel: "Some" }],
    });
    status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status.stale).toBe(true);
  });

  it("a failed job does not block a retry, and its message is safe to show", async () => {
    withKey();
    const { t, requestId, scheduled } = await setup();
    const { jobId } = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    await t.mutation(internal.agent.finishJob, {
      jobId, status: "failed", errorKind: "model_error", error: "The AI could not produce a draft this time. You can try again.",
    });
    const status = await t.query(api.agent.specStatus, { requestId, clientToken: token });
    expect(status.job).toMatchObject({ status: "failed", errorKind: "model_error" });
    const retry = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    expect(retry.reused).toBe(false);
    expect(retry.jobId).not.toBe(jobId);
    expect(await scheduled()).toHaveLength(2);
  });

  it("a run stuck for over 10 minutes no longer blocks a new one", async () => {
    withKey();
    const { t, requestId } = await setup();
    const first = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    await t.mutation(internal.agent.markJobRunning, { jobId: first.jobId });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const second = await t.mutation(api.agent.generateSpec, { requestId, clientToken: token });
    expect(second.reused).toBe(false);
  });

  it("specStatus rejects a wrong token", async () => {
    const { t, requestId } = await setup();
    await expect(t.query(api.agent.specStatus, { requestId, clientToken: "wrong-token" })).rejects.toThrow(/Draft not found/);
  });
});


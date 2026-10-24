/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

// Scheduled AI actions are queued but never run here (fake timers are not advanced),
// so no test touches the Anthropic API.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

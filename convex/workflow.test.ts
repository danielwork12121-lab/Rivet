/// <reference types="vite/client" />
// The workflow breakdown end to end: planWorkflow -> splitWorkflow (real action, Claude's HTTP
// transport stubbed) -> one match per robot-ready step -> latestWorkflow, sliders and labor cost.
// Every "model output" here is a hand-written TEST FIXTURE.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");

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

function stubClaude(fast: unknown, deep: unknown = { reasons: [] }) {
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return body.model === "claude-haiku-5-5" ? message(body.model, fast) : message(body.model, deep);
  }));
}

const split = { // TEST FIXTURE
  steps: [
    { stage: 1, name: "Mow the lawns", sharePct: 50, verdict: "automatable", why: "Robot mowers are sold today.", task: "Mowing", searchPhrase: "commercial robotic mower" },
    { stage: 2, name: "Edge the beds", sharePct: 20, verdict: "possible", why: "Few edging robots exist.", task: "edging", searchPhrase: "robotic lawn edger" },
    { stage: 3, name: "Talk to customers", sharePct: 20, verdict: "person", why: "Needs a person.", task: "customer service", searchPhrase: "n/a" },
    { stage: 4, name: "Blow clippings", sharePct: 10, verdict: "automatable", why: "Some robots do this.", task: "leaf blowing", searchPhrase: "robot leaf blower" },
  ],
  annualLaborCost: 80000, budget: null, requirements: [],
};

async function setup() {
  const raw = convexTest(schema, modules);
  const t = await asClient(raw);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.stubEnv("AI_MATCH_ENABLED", "true");
  const requestId = await t.mutation(api.requests.create, {
    title: "Fictional Green Lawns", environment: "Lawn care.", constraints: [],
    description: "Fictional: we mow, edge beds and blow clippings for 40 homes a week. Labor is about $80,000 a year.",
  });
  await raw.run((ctx) => ctx.db.insert("robots", {
    name: "Fictional Mower", vendor: "Fictional Vendor", task: "mowing", price: 20000, yearlyOpex: 2000,
    automationShare: 0.6, environments: [], url: "https://example.com/mower", sample: false,
    imageUrl: "https://example.com/mower.jpg",
  }));
  vi.useFakeTimers();
  const workflowId = await t.mutation(api.agent.planWorkflow, { requestId });
  vi.useRealTimers();
  return { raw, t, requestId, workflowId };
}

describe("workflow breakdown", () => {
  it("splits the job, searches robot-ready steps, and decides verdicts in code", async () => {
    const { raw, t, requestId, workflowId } = await setup();
    stubClaude(split);
    vi.useFakeTimers();
    await raw.action(internal.ai.splitWorkflow, { workflowId });
    const wf = (await raw.run((ctx) => ctx.db.get(workflowId)))!;
    expect(wf.status).toBe("ready");
    expect(wf.laborCost).toBe(80000);
    expect(wf.steps.map((s) => !!s.matchId)).toEqual([true, true, false, true]); // never the "person" step

    // Run the mowing step's match: it ranks the catalog robot for its share of the labor.
    const mowMatch = wf.steps[0].matchId!;
    expect((await raw.run((ctx) => ctx.db.get(mowMatch)))!.intent!.annualTaskCost).toBe(40000);
    await raw.action(internal.ai.matchRobots, { matchId: mowMatch });
    vi.useRealTimers();

    const view = (await t.query(api.agent.latestWorkflow, { requestId }))!;
    expect(view.steps.map((s) => s.verdict)).toEqual(["today", "checking", "person", "checking"]);
    expect(view.steps.map((s) => s.stage)).toEqual([1, 2, 3, 4]);
    expect(view.steps[0].picks[0]).toMatchObject({ name: "Fictional Mower", imageUrl: "https://example.com/mower.jpg" });
    expect(view.steps[0].bestSavings).toBeGreaterThan(0);
    expect(view.summary).toMatchObject({ steps: 4, automatable: 1, yearlySavings: view.steps[0].bestSavings });

    // Moving the slider re-ranks in code: a bigger share means more savings, no AI call.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no AI call expected"); }));
    await t.mutation(api.agent.setStepShare, { requestId, step: 0, sharePct: 80 });
    const after = (await t.query(api.agent.latestWorkflow, { requestId }))!;
    expect(after.steps[0].sharePct).toBe(80);
    expect(after.steps[0].annualCost).toBe(64000);
    expect(after.steps[0].bestSavings!).toBeGreaterThan(view.steps[0].bestSavings!);

    await t.mutation(api.agent.setWorkflowLabor, { requestId, laborCost: 100000 });
    expect((await t.query(api.agent.latestWorkflow, { requestId }))!.steps[0].annualCost).toBe(80000);
  });

  it("is owner-only and refuses bad slider values", async () => {
    const { raw, t, requestId, workflowId } = await setup();
    stubClaude(split);
    vi.useFakeTimers();
    await raw.action(internal.ai.splitWorkflow, { workflowId });
    vi.useRealTimers();
    const other = await asClient(raw, "user_client_b");
    await expect(other.query(api.agent.latestWorkflow, { requestId })).rejects.toThrow(/Draft not found/);
    await expect(t.mutation(api.agent.setStepShare, { requestId, step: 0, sharePct: 140 })).rejects.toThrow(/0 to 100/);
    await expect(t.mutation(api.agent.setStepShare, { requestId, step: 9, sharePct: 10 })).rejects.toThrow(/No such step/);
  });

  it("marks the breakdown failed with a safe message on a model error", async () => {
    const { raw, t, requestId, workflowId } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "internal detail" } }),
      { status: 400, headers: { "content-type": "application/json" } })));
    await raw.action(internal.ai.splitWorkflow, { workflowId });
    const view = (await t.query(api.agent.latestWorkflow, { requestId }))!;
    expect(view.status).toBe("failed");
    expect(view.error).not.toContain("internal detail");
  });
});

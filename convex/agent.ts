import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { loadOwnedDraft, withoutToken } from "./lib/drafts";

// Database side of the AI agent. Claude itself is called from ai.ts; these
// functions start the AI work and store what it produces.
//
// Every public function here belongs to one operator request, so each takes
// the draft's clientToken and checks it (lib/drafts.ts) before reading or
// scheduling anything. Nothing calls these automatically: the frontend must
// trigger them deliberately, since each one starts a paid Claude call.

const owner = { requestId: v.id("operatorRequests"), clientToken: v.string() };

function requireText(label: string, value: string, max: number) {
  const t = value.trim();
  if (!t || t.length > max) throw new ConvexError(`${label} must be 1-${max} characters`);
  return t;
}

// ---------- 1. Requirement spec + follow-up questions ----------

// Frontend calls this after requests:create. Returns right away; the spec
// appears in agent:latestSpec a few seconds later.
export const generateSpec = mutation({
  args: owner,
  handler: async (ctx, { requestId, clientToken }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    await ctx.scheduler.runAfter(0, internal.ai.extractSpec, { requestId });
  },
});

// The operator answers the AI's follow-up questions; the spec is redone.
export const answerQuestions = mutation({
  args: {
    ...owner,
    answers: v.array(v.object({ question: v.string(), answer: v.string() })),
  },
  handler: async (ctx, { requestId, clientToken, answers }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    if (answers.length > 10) throw new ConvexError("At most 10 answers at a time");
    for (const a of answers) {
      if (!a.answer.trim()) continue;
      await ctx.db.insert("clarifications", {
        requestId,
        question: requireText("question", a.question, 500),
        answer: requireText("answer", a.answer, 1000),
      });
    }
    await ctx.scheduler.runAfter(0, internal.ai.extractSpec, { requestId });
  },
});

export const latestSpec = query({
  args: owner,
  handler: async (ctx, { requestId, clientToken }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    return ctx.db
      .query("requirementSpecs")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .first();
  },
});

export const latestSpecInternal = internalQuery({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) =>
    ctx.db
      .query("requirementSpecs")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .first(),
});

// Everything Claude needs to know about a request.
export const requestContext = internalQuery({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Request not found");
    const clarifications = await ctx.db
      .query("clarifications")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .collect();
    return {
      request: withoutToken(request), // never send the draft token to Claude
      answers: clarifications.map((c) => ({ question: c.question, answer: c.answer })),
    };
  },
});

export const saveSpec = internalMutation({
  args: {
    requestId: v.id("operatorRequests"),
    model: v.string(),
    summary: v.string(),
    tasks: v.array(v.string()),
    environmentFactors: v.array(v.object({ name: v.string(), value: v.string() })),
    requirements: v.array(
      v.object({
        kind: v.union(
          v.literal("performance"), v.literal("safety"), v.literal("environmental"),
          v.literal("budget"), v.literal("other"),
        ),
        description: v.string(),
        value: v.optional(v.number()),
        unit: v.optional(v.string()),
        mandatory: v.boolean(),
      }),
    ),
    confidence: v.number(),
    followUpQuestions: v.array(v.string()),
  },
  handler: async (ctx, { requestId, ...spec }) => {
    await ctx.db.insert("requirementSpecs", { requestId, source: "ai", status: "draft", ...spec });
    await ctx.db.patch(requestId, { status: "specified" });
  },
});

// ---------- 2. "Best for you" robot picks ----------

export const recommend = mutation({
  args: { ...owner, maxPrice: v.optional(v.number()) },
  handler: async (ctx, { requestId, clientToken, maxPrice }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    if (maxPrice !== undefined && !(Number.isFinite(maxPrice) && maxPrice >= 0)) {
      throw new ConvexError("maxPrice must be a non-negative number");
    }
    await ctx.scheduler.runAfter(0, internal.ai.recommendRobots, { requestId, maxPrice });
  },
});

export const latestPicks = query({
  args: owner,
  handler: async (ctx, { requestId, clientToken }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    return ctx.db
      .query("recommendations")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .first();
  },
});

export const savePicks = internalMutation({
  args: {
    requestId: v.id("operatorRequests"),
    picks: v.array(
      v.object({
        robotId: v.id("robots"),
        reason: v.string(),
        paybackMonths: v.union(v.number(), v.null()),
        yearlyNetSavings: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("recommendations", args);
  },
});

// ---------- 3. "Not quite right? Request a bounty" ----------

export const requestBounty = mutation({
  args: { ...owner, robotId: v.optional(v.id("robots")), gap: v.string() },
  handler: async (ctx, { requestId, clientToken, robotId, gap }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    await ctx.scheduler.runAfter(0, internal.ai.writeBounty, {
      requestId,
      ...(robotId ? { robotId } : {}),
      gap: requireText("gap", gap, 1000),
    });
  },
});

export const latestBounty = query({
  args: owner,
  handler: async (ctx, { requestId, clientToken }) => {
    await loadOwnedDraft(ctx, requestId, clientToken);
    // The latest AI-written draft; posted bounties are read via bounties:getMine.
    return ctx.db
      .query("bounties")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .filter((q) => q.eq(q.field("source"), "ai"))
      .first();
  },
});

export const saveBounty = internalMutation({
  args: {
    requestId: v.id("operatorRequests"),
    title: v.string(),
    summary: v.string(),
    mustHaves: v.array(v.string()),
    niceToHaves: v.array(v.string()),
    acceptanceTest: v.string(),
    goal: v.number(),
  },
  handler: async (ctx, args) => {
    // An AI brief is a private draft until the operator posts a bounty themselves.
    await ctx.db.insert("bounties", { ...args, pledged: 0, status: "draft", source: "ai" });
  },
});

// ---------- Logging ----------

export const logRun = internalMutation({
  args: {
    route: v.string(),
    ms: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    ok: v.boolean(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, run) => {
    await ctx.db.insert("agentRuns", run);
  },
});
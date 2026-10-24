import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { loadOwnedDraft, withoutToken } from "./lib/drafts";
import { AI_BLOCK_MESSAGES, budgetBlock, spendAiBudget, type AiBlock } from "./lib/aiBudget";

// Database side of the AI agent. Claude itself is called from ai.ts; these
// functions start the AI work and store what it produces.
//
// Every public function here belongs to one operator request, so each checks
// that the signed-in Client owns it (lib/drafts.ts) before reading or scheduling
// anything. Nothing calls these automatically: the frontend must trigger them
// deliberately, since each one starts a paid Claude call.

// clientToken is accepted for compatibility with callers written before accounts,
// and ignored: ownership comes only from the verified sign-in.
const owner = { requestId: v.id("operatorRequests"), clientToken: v.optional(v.string()) };

// AI calls need an Anthropic key in the backend's environment (npx convex env set
// ANTHROPIC_API_KEY ...). It never reaches the browser; only this yes/no does.
const aiAvailable = () => !!process.env.ANTHROPIC_API_KEY;
const AI_UNAVAILABLE = "AI drafting is unavailable: no Anthropic API key is configured on the backend.";

// Why a new paid call can't start right now (no key, or a daily limit), or null.
async function aiUnavailable(ctx: QueryCtx, scope: { requestId?: Id<"operatorRequests">; userId?: Id<"users"> } = {}) {
  if (!aiAvailable()) return { reason: "no_key" as const, message: AI_UNAVAILABLE };
  const block: AiBlock | null = await budgetBlock(ctx, scope);
  return block && { reason: block, message: AI_BLOCK_MESSAGES[block] };
}

// A request's version: changes on every edit to the intake or follow-up answers.
export const requestVersion = (r: Doc<"operatorRequests">) => r.updatedAt ?? r._creationTime;

// A queued/running run older than this no longer blocks a new one (e.g. a crashed action).
const STUCK_JOB_MS = 10 * 60 * 1000;

// Starts a spec run, or returns the one already in progress so repeated clicks
// never start a second paid call. Mutations are serializable, so this can't race.
async function enqueueSpecJob(ctx: MutationCtx, request: Doc<"operatorRequests">) {
  const latest = await ctx.db
    .query("aiJobs")
    .withIndex("by_request_kind", (q) => q.eq("requestId", request._id).eq("kind", "spec"))
    .order("desc")
    .first();
  const active = latest && (latest.status === "queued" || latest.status === "running");
  if (active && Date.now() - (latest.startedAt ?? latest._creationTime) < STUCK_JOB_MS) {
    return { jobId: latest._id, reused: true };
  }
  await spendAiBudget(ctx, "spec", { requestId: request._id, userId: request.ownerId }); // throws if a daily limit is reached
  const jobId = await ctx.db.insert("aiJobs", { requestId: request._id, kind: "spec", status: "queued" });
  await ctx.scheduler.runAfter(0, internal.ai.extractSpec, { requestId: request._id, jobId });
  return { jobId, reused: false };
}

// Whether a new AI call could start right now, and if not, why. No secrets.
export const aiStatus = query({
  args: {},
  handler: async (ctx) => {
    const blocked = await aiUnavailable(ctx);
    return blocked ? { available: false, reason: blocked.reason, message: blocked.message } : { available: true };
  },
});

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
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (!aiAvailable()) throw new ConvexError(AI_UNAVAILABLE);
    return await enqueueSpecJob(ctx, request);
  },
});

// The operator answers the AI's follow-up questions; the spec is redone.
export const answerQuestions = mutation({
  args: {
    ...owner,
    answers: v.array(v.object({ question: v.string(), answer: v.string() })),
  },
  handler: async (ctx, { requestId, answers }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (answers.length > 10) throw new ConvexError("At most 10 answers at a time");
    for (const a of answers) {
      if (!a.answer.trim()) continue;
      await ctx.db.insert("clarifications", {
        requestId,
        question: requireText("question", a.question, 500),
        answer: requireText("answer", a.answer, 1000),
      });
    }
    // Answers are kept either way; the spec is redone only when AI is available
    // and within budget.
    return (await aiUnavailable(ctx, { requestId, userId: request.ownerId })) ? null : await enqueueSpecJob(ctx, request);
  },
});

export const latestSpec = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
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
    jobId: v.optional(v.id("aiJobs")),
    requestVersion: v.optional(v.number()),
  },
  handler: async (ctx, { requestId, ...spec }) => {
    const specId = await ctx.db.insert("requirementSpecs", { requestId, source: "ai", status: "draft", ...spec });
    await ctx.db.patch(requestId, { status: "specified" });
    return specId;
  },
});

// ---------- Job lifecycle (aiJobs) ----------

// Returns false if the job is no longer queued (e.g. already picked up), so the
// action stops instead of making a second paid call.
export const markJobRunning = internalMutation({
  args: { jobId: v.id("aiJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "queued") return false;
    await ctx.db.patch(jobId, { status: "running", startedAt: Date.now() });
    return true;
  },
});

export const finishJob = internalMutation({
  args: {
    jobId: v.id("aiJobs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    specId: v.optional(v.id("requirementSpecs")),
    errorKind: v.optional(v.union(v.literal("unavailable"), v.literal("model_error"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, ...result }) => {
    await ctx.db.patch(jobId, { ...result, finishedAt: Date.now() });
  },
});

// Everything the page needs to show the AI draft for the caller's own request:
// whether AI is available, the latest run, the latest AI spec and whether it is
// stale, and the AI's own clarification Q&A (separate from the fixed follow-ups).
export const specStatus = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    const job = await ctx.db
      .query("aiJobs")
      .withIndex("by_request_kind", (q) => q.eq("requestId", requestId).eq("kind", "spec"))
      .order("desc")
      .first();
    const spec = await ctx.db
      .query("requirementSpecs")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .first();
    const clarifications = await ctx.db
      .query("clarifications")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .collect();
    const currentVersion = requestVersion(request);
    const blocked = await aiUnavailable(ctx, { requestId, userId: request.ownerId });
    return {
      available: !blocked,
      unavailableReason: blocked?.reason,
      unavailableMessage: blocked?.message,
      job: job && {
        _id: job._id, status: job.status, errorKind: job.errorKind, error: job.error,
        queuedAt: job._creationTime, startedAt: job.startedAt, finishedAt: job.finishedAt,
      },
      spec,
      // A spec without a recorded version predates job tracking: treat it as stale.
      stale: !!spec && (spec.requestVersion ?? -1) < currentVersion,
      clarifications: clarifications.map((c) => ({ question: c.question, answer: c.answer })),
    };
  },
});

// ---------- 2. "Best for you" robot picks ----------

export const recommend = mutation({
  args: { ...owner, maxPrice: v.optional(v.number()) },
  handler: async (ctx, { requestId, maxPrice }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (maxPrice !== undefined && !(Number.isFinite(maxPrice) && maxPrice >= 0)) {
      throw new ConvexError("maxPrice must be a non-negative number");
    }
    if (!aiAvailable()) throw new ConvexError(AI_UNAVAILABLE);
    await spendAiBudget(ctx, "recommend", { requestId, userId: request.ownerId });
    await ctx.scheduler.runAfter(0, internal.ai.recommendRobots, { requestId, maxPrice });
  },
});

export const latestPicks = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
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
  handler: async (ctx, { requestId, robotId, gap }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    const cleanGap = requireText("gap", gap, 1000);
    if (!aiAvailable()) throw new ConvexError(AI_UNAVAILABLE);
    await spendAiBudget(ctx, "bounty", { requestId, userId: request.ownerId });
    await ctx.scheduler.runAfter(0, internal.ai.writeBounty, {
      requestId,
      ...(robotId ? { robotId } : {}),
      gap: cleanGap,
    });
  },
});

export const latestBounty = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
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
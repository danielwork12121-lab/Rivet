import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { loadOwnedDraft, withoutToken } from "./lib/drafts";
import { AI_BLOCK_MESSAGES, budgetBlock, spendAiBudget, type AiBlock } from "./lib/aiBudget";
import { intentInfo, matchNext, matchPick, workflowStep } from "./schema";
import { dataSourceOf } from "./matching";
import { nextAction, rankRobots, type Requirement } from "./lib/decide";
import { isSpecName } from "./lib/specs";
import { numbersIn } from "./lib/verify";
import { stepCost, stepVerdict, stepsToSearch, workflowSummary } from "./lib/workflow";

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
// ---------- 4. "Find robots for me" (fast read -> decide -> explain) ----------
// Paid: a run is one fast Claude read plus one Claude explanation, and may start an Apify web
// search (gated separately in discovery.start). Off unless AI_MATCH_ENABLED=true and a key is
// set; only the owning Client; one unit of AI budget per new run (reusing one in progress is free).
// matching.ts (saved requirements, no AI) shares the matches table; its rows carry engine "rules"
// and this flow neither reads nor replaces them.

const matchEnabled = () => process.env.AI_MATCH_ENABLED === "true" && aiAvailable();
const MATCH_OFF = "AI robot matching is turned off on this backend.";

// The latest row this flow made for a request (rows from before `engine` existed count as ours).
async function latestAgentMatch(ctx: QueryCtx, requestId: Id<"operatorRequests">) {
  const rows = await ctx.db
    .query("matches")
    .withIndex("by_request", (q) => q.eq("requestId", requestId))
    .order("desc")
    .take(50);
  return rows.find((m) => m.engine !== "rules" && m.workflowId === undefined) ?? null;
}

// Starts a paid run, or (with reuse) returns the one still in progress so repeated clicks never
// start a second. Throws a safe message if a daily limit is reached. Mutations are serializable,
// so concurrent clicks can't both pass the budget check.
async function startAgentMatch(ctx: MutationCtx, request: Doc<"operatorRequests">, reuse: boolean) {
  if (reuse) {
    const latest = await latestAgentMatch(ctx, request._id);
    if (latest && (latest.status === "reading" || latest.status === "searching") &&
        Date.now() - latest._creationTime < STUCK_JOB_MS) {
      return latest._id;
    }
  }
  await spendAiBudget(ctx, "match", { requestId: request._id, userId: request.ownerId });
  const matchId = await ctx.db.insert("matches", { requestId: request._id, status: "reading", picks: [], engine: "agent" });
  await ctx.scheduler.runAfter(0, internal.ai.matchRobots, { matchId });
  return matchId;
}

// Frontend calls this once the operator has described the job. Returns the match
// id right away; agent:latestMatch fills in over the next few seconds.
export const findRobots = mutation({
  args: owner,
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (!matchEnabled()) throw new ConvexError(MATCH_OFF);
    return await startAgentMatch(ctx, request, true);
  },
});

// The operator answers "how much does this task cost you a year?"; matching is redone.
// The cost is saved either way; a new run starts only when matching is on and within budget.
export const setTaskCost = mutation({
  args: { ...owner, annualTaskCost: v.number() },
  handler: async (ctx, { requestId, annualTaskCost }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (!(Number.isFinite(annualTaskCost) && annualTaskCost > 0 && annualTaskCost < 100_000_000)) {
      throw new ConvexError("annualTaskCost must be a positive number of dollars");
    }
    await ctx.db.patch(requestId, {
      cost: { ...(request.cost ?? { currency: "USD" }), currentAnnualCost: annualTaskCost },
      updatedAt: Date.now(),
    });
    if (!matchEnabled() || (await budgetBlock(ctx, { requestId, userId: request.ownerId, kind: "match" }))) return null;
    return await startAgentMatch(ctx, request, false);
  },
});

// A match's picks with each robot's details and source, for the page.
async function picksWithRobots(ctx: QueryCtx, picks: Doc<"matches">["picks"]) {
  const robots = [];
  for (const p of picks) {
    const r = await ctx.db.get(p.robotId);
    if (!r) continue;
    robots.push({
      ...p,
      name: r.name, vendor: r.vendor, url: r.url, sample: r.sample,
      price: r.priceStatus === "quote_only" ? null : r.price,
      yearlyOpex: r.priceStatus === "quote_only" ? null : r.yearlyOpex,
      specs: r.specs ?? [],
      fetchedAt: r.fetchedAt ?? null,
      dataSource: dataSourceOf(r),
      imageUrl: r.imageUrl ?? null,
    });
  }
  return robots;
}

// Everything the page needs to show the latest match, with each robot's details
// and sources, and the web search's progress while one is running.
export const latestMatch = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
    const match = await latestAgentMatch(ctx, requestId);
    if (!match) return null;
    const robots = await picksWithRobots(ctx, match.picks);
    const search = match.intent && match.status === "searching"
      ? await ctx.db.query("discoveries").withIndex("by_task", (q) => q.eq("task", match.intent!.task)).first()
      : null;
    return {
      _id: match._id,
      status: match.status,
      intent: match.intent ?? null,
      next: match.next ?? null,
      error: match.error ?? null,
      msToRanked: match.msToRanked ?? null,
      searchNote: match.searchNote ?? null,
      picks: robots,
      search: search && { status: search.status, sitesFound: search.urls.length },
    };
  },
});

export const getMatch = internalQuery({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => ctx.db.get(matchId),
});

export const patchMatch = internalMutation({
  args: {
    matchId: v.id("matches"),
    status: v.optional(
      v.union(v.literal("reading"), v.literal("searching"), v.literal("ranked"), v.literal("done"), v.literal("failed")),
    ),
    intent: v.optional(intentInfo),
    picks: v.optional(v.array(matchPick)),
    next: v.optional(matchNext),
    error: v.optional(v.string()),
    msToRanked: v.optional(v.number()),
  },
  handler: async (ctx, { matchId, ...patch }) => {
    await ctx.db.patch(matchId, patch);
  },
});

// ---------- 5. Workflow breakdown: split the job into steps, search the robot-ready ones ----------
// One paid run (one unit of AI budget) splits the job with the fast model and searches up to
// SEARCH_CAP steps. Moving a step's slider or giving the job's labor cost re-ranks in plain code
// (no AI, no budget); "Check this step" on an unsearched step is a new paid search.

async function latestWorkflowRow(ctx: QueryCtx, requestId: Id<"operatorRequests">) {
  return await ctx.db.query("workflows").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").first();
}

// Starts the search for one step: a match whose intent is already known, so matchRobots skips
// its read and goes straight to the catalog (or a web search) and ranking.
async function startStepMatch(ctx: MutationCtx, wf: Doc<"workflows">, step: number) {
  const s = wf.steps[step];
  const matchId = await ctx.db.insert("matches", {
    requestId: wf.requestId, status: "reading", picks: [], engine: "agent", workflowId: wf._id, step,
    intent: {
      task: s.task, searchPhrase: s.searchPhrase,
      annualTaskCost: stepCost(wf.laborCost, s.sharePct), budget: wf.budget, requirements: wf.requirements,
    },
  });
  await ctx.scheduler.runAfter(0, internal.ai.matchRobots, { matchId });
  return matchId;
}

// Re-ranks a step's robots for a new yearly cost. Plain code; explanations are kept unless they
// quote a money figure or month count that is no longer true.
async function rerankStep(ctx: MutationCtx, matchId: Id<"matches">, annualTaskCost: number | null) {
  const match = await ctx.db.get(matchId);
  if (!match?.intent) return;
  const intent = { ...match.intent, annualTaskCost };
  if (match.status !== "done" && match.status !== "ranked") {
    await ctx.db.patch(matchId, { intent }); // a running search ranks with this cost when it finishes
    return;
  }
  const robots = (await ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", intent.task)).collect())
    .filter((r) => !r.sample);
  const typed = { ...intent, requirements: intent.requirements.filter((r) => isSpecName(r.name)) as Requirement[] };
  const ranked = rankRobots(typed, robots.map((r) => ({ ...r, _id: r._id as string })));
  const byId = new Map(robots.map((r) => [r._id as string, r]));
  const oldReasons = new Map(match.picks.map((p) => [p.robotId as string, p.reason]));
  const picks = ranked.map((p) => {
    const r = byId.get(p.robotId)!;
    const allowed = new Set(
      [r.priceStatus === "quote_only" ? null : r.price, p.paybackMonths, p.yearlyNetSavings, p.breakEvenAnnualCost, annualTaskCost, intent.budget]
        .filter((n) => n !== null && n !== undefined).map(String),
    );
    const reason = oldReasons.get(p.robotId);
    const keep = reason && numbersIn(reason).every((n) => allowed.has(n));
    return { ...p, robotId: p.robotId as Id<"robots">, ...(keep ? { reason } : {}) };
  });
  await ctx.db.patch(matchId, { intent, picks, next: nextAction(typed, ranked) });
}

// "Break this job down": splits the job into steps and searches the biggest robot-ready ones.
export const planWorkflow = mutation({
  args: owner,
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (!matchEnabled()) throw new ConvexError(MATCH_OFF);
    const latest = await latestWorkflowRow(ctx, requestId);
    if (latest && latest.status === "splitting" && Date.now() - latest._creationTime < STUCK_JOB_MS) return latest._id;
    await spendAiBudget(ctx, "match", { requestId, userId: request.ownerId });
    const workflowId = await ctx.db.insert("workflows", {
      requestId, status: "splitting", steps: [], laborCost: request.cost?.currentAnnualCost ?? null,
      budget: null, requirements: [],
    });
    await ctx.scheduler.runAfter(0, internal.ai.splitWorkflow, { workflowId });
    return workflowId;
  },
});

export const getWorkflow = internalQuery({
  args: { workflowId: v.id("workflows") },
  handler: async (ctx, { workflowId }) => ctx.db.get(workflowId),
});

// Saves the AI's steps (already cleaned by lib/workflow.ts) and starts the searches.
export const saveWorkflowSteps = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    steps: v.array(workflowStep),
    laborCost: v.union(v.number(), v.null()),
    budget: v.union(v.number(), v.null()),
    requirements: intentInfo.fields.requirements,
  },
  handler: async (ctx, { workflowId, steps, laborCost, budget, requirements }) => {
    const wf = await ctx.db.get(workflowId);
    if (!wf) return;
    await ctx.db.patch(workflowId, { status: "ready", steps, laborCost: wf.laborCost ?? laborCost, budget, requirements });
    let current = (await ctx.db.get(workflowId))!;
    for (const i of stepsToSearch(steps)) {
      const matchId = await startStepMatch(ctx, current, i);
      const next = current.steps.map((s, k) => (k === i ? { ...s, matchId } : s));
      await ctx.db.patch(workflowId, { steps: next });
      current = { ...current, steps: next };
    }
  },
});

export const failWorkflow = internalMutation({
  args: { workflowId: v.id("workflows"), error: v.string() },
  handler: async (ctx, { workflowId, error }) => {
    await ctx.db.patch(workflowId, { status: "failed", error });
  },
});

// The latest breakdown with each step's verdict (decided here, in code), its robots and the totals.
export const latestWorkflow = query({
  args: owner,
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
    const wf = await latestWorkflowRow(ctx, requestId);
    if (!wf) return null;
    const steps = [];
    for (const [index, s] of wf.steps.entries()) {
      const match = s.matchId ? await ctx.db.get(s.matchId) : null;
      const picks = match ? await picksWithRobots(ctx, match.picks) : [];
      const verdict = stepVerdict(s.aiVerdict, match && {
        status: match.status, pickCount: match.picks.length, next: match.next ?? null,
        searchSkipped: !!match.searchNote && /^Web search (is turned off|skipped|failed)/.test(match.searchNote),
      });
      const fits = picks.filter((p) => !p.fit.some((f) => f.mandatory && f.status === "misses"));
      const savings = fits.map((p) => p.yearlyNetSavings).filter((n): n is number => n !== null);
      const paybacks = fits.map((p) => p.paybackMonths).filter((n): n is number => n !== null);
      const search = match?.status === "searching" && match.intent
        ? await ctx.db.query("discoveries").withIndex("by_task", (q) => q.eq("task", match.intent!.task)).first()
        : null;
      steps.push({
        index, stage: s.stage ?? index + 1, name: s.name, sharePct: s.sharePct, aiVerdict: s.aiVerdict, why: s.why, task: s.task,
        verdict,
        annualCost: stepCost(wf.laborCost, s.sharePct),
        matchStatus: match?.status ?? null,
        searchNote: match?.searchNote ?? null,
        next: match?.next ?? null,
        search: search && { status: search.status, sitesFound: search.urls.length },
        picks,
        bestSavings: savings.length ? Math.max(...savings) : null,
        bestPaybackMonths: paybacks.length ? Math.min(...paybacks) : null,
      });
    }
    return {
      _id: wf._id, status: wf.status, error: wf.error ?? null, laborCost: wf.laborCost,
      steps, summary: workflowSummary(steps),
    };
  },
});

async function ownedWorkflow(ctx: MutationCtx, requestId: Id<"operatorRequests">) {
  const request = await loadOwnedDraft(ctx, requestId);
  const wf = await latestWorkflowRow(ctx, requestId);
  if (!wf || wf.status !== "ready") throw new ConvexError("Break the job down first.");
  return { request, wf };
}

// The Client moves a step's slider: saves the share and re-ranks that step for its new cost.
export const setStepShare = mutation({
  args: { ...owner, step: v.number(), sharePct: v.number() },
  handler: async (ctx, { requestId, step, sharePct }) => {
    const { wf } = await ownedWorkflow(ctx, requestId);
    if (!wf.steps[step]) throw new ConvexError("No such step.");
    if (!(Number.isFinite(sharePct) && sharePct >= 0 && sharePct <= 100)) throw new ConvexError("Share must be 0 to 100.");
    const share = Math.round(sharePct);
    await ctx.db.patch(wf._id, { steps: wf.steps.map((s, k) => (k === step ? { ...s, sharePct: share } : s)) });
    const matchId = wf.steps[step].matchId;
    if (matchId) await rerankStep(ctx, matchId, stepCost(wf.laborCost, share));
  },
});

// The Client gives the whole job's yearly labor cost: every step is re-ranked with its share of it.
export const setWorkflowLabor = mutation({
  args: { ...owner, laborCost: v.number() },
  handler: async (ctx, { requestId, laborCost }) => {
    const { request, wf } = await ownedWorkflow(ctx, requestId);
    if (!(Number.isFinite(laborCost) && laborCost > 0 && laborCost < 100_000_000)) {
      throw new ConvexError("laborCost must be a positive number of dollars");
    }
    await ctx.db.patch(requestId, {
      cost: { ...(request.cost ?? { currency: "USD" }), currentAnnualCost: laborCost }, updatedAt: Date.now(),
    });
    await ctx.db.patch(wf._id, { laborCost });
    for (const s of wf.steps) if (s.matchId) await rerankStep(ctx, s.matchId, stepCost(laborCost, s.sharePct));
  },
});

// "Check this step": a paid search for a step that wasn't searched up front (or whose search failed).
export const checkStep = mutation({
  args: { ...owner, step: v.number() },
  handler: async (ctx, { requestId, step }) => {
    const { request, wf } = await ownedWorkflow(ctx, requestId);
    if (!matchEnabled()) throw new ConvexError(MATCH_OFF);
    const s = wf.steps[step];
    if (!s) throw new ConvexError("No such step.");
    const existing = s.matchId ? await ctx.db.get(s.matchId) : null;
    const skipped = existing?.status === "done" && existing.picks.length === 0 && /^Web search (is turned off|skipped|failed)/.test(existing.searchNote ?? "");
    if (existing && existing.status !== "failed" && !skipped) return existing._id;
    await spendAiBudget(ctx, "match", { requestId, userId: request.ownerId });
    const matchId = await startStepMatch(ctx, wf, step);
    await ctx.db.patch(wf._id, { steps: wf.steps.map((x, k) => (k === step ? { ...x, matchId } : x)) });
    return matchId;
  },
});

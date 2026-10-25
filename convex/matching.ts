import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { loadOwnedDraft } from "./lib/drafts";
import { nextAction, normalizeTask, rankRobots, type Intent, type Requirement, type RobotFacts } from "./lib/decide";
import { SPEC_LABELS, isSpecName, type SpecName } from "./lib/specs";

// Robot matching for a signed-in Client's own request: rank the catalog with lib/decide.ts (plain
// code, no AI) and save the result under that request. Every function here goes through
// loadOwnedDraft, so only the owning Client can save inputs, run matching or read results
// (lib/auth.ts, lib/drafts.ts). It calls no external service and schedules nothing.
//
// What to match is saved on the request (`matchingInput`: task + optional requirements) and the annual
// task cost in the existing `cost.currentAnnualCost`, so the page doesn't resend them. Anything passed
// to findRobots is saved the same way. Changing the saved input replaces the stored result at once;
// saving identical input changes nothing.
//
// Provenance is explicit (see dataSourceOf and fitSources): robots flagged `sample` are fictional demo
// data, robots read from a vendor page carry their quotes and source URLs (the only verified figures),
// and anything else is unverified. A requirement's own `basis` says whether the Client gave an estimate
// or says they measured it; Rivet verifies neither.

const FICTIONAL_NOTE =
  "Fictional sample robot: its price, running cost and automation share are illustrative, not vendor data.";
const SLOPE_NOTE = "Slope requirement comes from your follow-up answer, which is an illustrative figure.";
const estimateNote = (name: SpecName) =>
  `Your ${SPEC_LABELS[name]} requirement is your own estimate, not a measured or verified figure.`;
const MAX_REQUIREMENTS = 10;
const MAX_ROBOTS = 500;

// Fictional demo robots are hidden unless this deployment says otherwise. Only an isolated test
// deployment should set SHOW_SAMPLE_ROBOTS=true; production never shows them (ai.matchRobots
// drops them too). When shown, every result labels them (FICTIONAL_NOTE, dataSource).
const showSamples = () => process.env.SHOW_SAMPLE_ROBOTS === "true";

// This flow's latest row for a request. The AI flow (agent:findRobots) shares the matches table;
// its rows have no engine or engine "agent", and this file never reads or replaces them.
async function latestRulesMatch(ctx: QueryCtx, requestId: Doc<"operatorRequests">["_id"]) {
  const rows = await ctx.db.query("matches").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").take(50);
  return rows.find((m) => m.engine === "rules") ?? null;
}

type Basis = "estimate" | "measured";
type SavedRequirement = { name: string; op: "atLeast" | "atMost"; value: number; mandatory: boolean; basis: Basis };
type SavedInput = NonNullable<Doc<"operatorRequests">["matchingInput"]>;

const requirementArg = v.object({
  name: v.string(),
  op: v.union(v.literal("atLeast"), v.literal("atMost")),
  value: v.number(),
  mandatory: v.boolean(),
  basis: v.optional(v.union(v.literal("estimate"), v.literal("measured"))), // default: estimate
});

export type DataSource = "fictional_sample" | "vendor_sourced" | "unverified";

// Where a robot's numbers come from, from its stored row.
export function dataSourceOf(r: Doc<"robots">): DataSource {
  if (r.sample) return "fictional_sample";
  if (r.fetchedAt !== undefined && ((r.specs?.length ?? 0) > 0 || r.priceStatus !== undefined)) return "vendor_sourced";
  return "unverified";
}

// ---------- validation (all of it before anything is written) ----------

function checkTask(task: string): string {
  const name = normalizeTask(task);
  if (name.length === 0 || name.length > 60) throw new ConvexError("task must be 1-60 characters");
  return name;
}

function checkCost(annualTaskCost: number) {
  if (!(Number.isFinite(annualTaskCost) && annualTaskCost > 0 && annualTaskCost < 100_000_000)) {
    throw new ConvexError("annualTaskCost must be a positive number of dollars");
  }
}

// Validated requirements in a canonical order, so the same set always compares equal.
function checkRequirements(raw: { name: string; op: "atLeast" | "atMost"; value: number; mandatory: boolean; basis?: Basis }[]): SavedRequirement[] {
  if (raw.length > MAX_REQUIREMENTS) throw new ConvexError(`At most ${MAX_REQUIREMENTS} requirements allowed`);
  const seen = new Set<string>();
  const out = raw.map((r) => {
    if (!isSpecName(r.name)) throw new ConvexError(`Unknown requirement: ${r.name.slice(0, 40)}`);
    if (!Number.isFinite(r.value) || r.value < 0 || r.value > 1e7) {
      throw new ConvexError("Requirement values must be non-negative numbers");
    }
    const key = `${r.name}:${r.op}`;
    if (seen.has(key)) throw new ConvexError(`Duplicate requirement: ${SPEC_LABELS[r.name]} (${r.op})`);
    seen.add(key);
    return { name: r.name, op: r.op, value: r.value, mandatory: r.mandatory, basis: r.basis ?? ("estimate" as Basis) };
  });
  return out.sort((a, b) => (a.name + a.op).localeCompare(b.name + b.op));
}

const sameRequirement = (a: SavedRequirement, b: SavedRequirement) =>
  a.name === b.name && a.op === b.op && a.value === b.value && a.mandatory === b.mandatory && a.basis === b.basis;
function sameInput(a: SavedInput, b: { task: string; requirements?: SavedRequirement[] }) {
  if (a.task !== b.task) return false;
  if (a.requirements === undefined || b.requirements === undefined) return a.requirements === b.requirements;
  return a.requirements.length === b.requirements.length && a.requirements.every((r, i) => sameRequirement(r, b.requirements![i]));
}

// ---------- saving the input ----------

// Validates, then saves whatever was given on the request. Returns the (possibly updated) request and
// whether anything actually changed. Nothing is written if anything is invalid or nothing changed.
async function applyInput(
  ctx: MutationCtx,
  request: Doc<"operatorRequests">,
  args: { task?: string; annualTaskCost?: number; requirements?: Parameters<typeof checkRequirements>[0] },
) {
  const task = args.task === undefined ? undefined : checkTask(args.task);
  const requirements = args.requirements === undefined ? undefined : checkRequirements(args.requirements);
  if (args.annualTaskCost !== undefined) checkCost(args.annualTaskCost);

  const saved = request.matchingInput;
  let nextInput: SavedInput | undefined = saved;
  if (task !== undefined || requirements !== undefined) {
    const nextTask = task ?? saved?.task;
    if (nextTask === undefined) throw new ConvexError("task is required the first time you save matching requirements");
    const nextReqs = requirements ?? saved?.requirements;
    const candidate = { task: nextTask, ...(nextReqs !== undefined ? { requirements: nextReqs } : {}) };
    if (!saved || !sameInput(saved, candidate)) nextInput = { ...candidate, updatedAt: Date.now() };
  }
  const inputChanged = nextInput !== saved;
  const costChanged = args.annualTaskCost !== undefined && request.cost?.currentAnnualCost !== args.annualTaskCost;
  if (!inputChanged && !costChanged) return { request, changed: false };

  const patch: Partial<Doc<"operatorRequests">> = {};
  if (inputChanged) patch.matchingInput = nextInput;
  if (costChanged) {
    patch.cost = { ...(request.cost ?? { currency: "USD" }), currentAnnualCost: args.annualTaskCost };
    patch.updatedAt = Date.now(); // the cost is part of the request itself
  }
  await ctx.db.patch(request._id, patch);
  return { request: (await ctx.db.get(request._id))!, changed: true };
}

// ---------- computing ----------

// With no saved requirements, the slope follow-up answer (an illustrative number the page attaches to
// the chip) becomes a non-mandatory "handles at least this slope" requirement.
function requirementsFor(request: Doc<"operatorRequests">) {
  const saved = request.matchingInput?.requirements;
  if (saved !== undefined) {
    const usable = saved.filter((r) => isSpecName(r.name));
    return {
      requirements: usable.map((r) => ({ name: r.name as SpecName, op: r.op, value: r.value, mandatory: r.mandatory })) as Requirement[],
      bases: usable.map((r) => r.basis as Basis | "derived_from_answers"),
      notes: usable.filter((r) => r.basis === "estimate").map((r) => estimateNote(r.name as SpecName)),
    };
  }
  const slope = request.followUps?.find((f) => f.key === "slope")?.assumption?.value;
  if (slope === undefined) return { requirements: [] as Requirement[], bases: [] as (Basis | "derived_from_answers")[], notes: [] as string[] };
  return {
    requirements: [{ name: "max_slope_deg", op: "atLeast", value: slope, mandatory: false }] as Requirement[],
    bases: ["derived_from_answers" as const],
    notes: [SLOPE_NOTE],
  };
}

function intentFor(request: Doc<"operatorRequests">, task: string): Intent {
  return {
    task,
    annualTaskCost: request.cost?.currentAnnualCost ?? null,
    budget: request.cost?.budget ?? null,
    requirements: requirementsFor(request).requirements,
  };
}

function toFacts(r: Doc<"robots">): RobotFacts {
  return {
    _id: r._id,
    name: r.name,
    price: r.price,
    priceStatus: r.priceStatus,
    yearlyOpex: r.yearlyOpex,
    automationShare: r.automationShare,
    specs: r.specs?.map((s) => ({ name: s.name, value: s.value })),
    slopeLimitDeg: r.slopeLimitDeg,
    assumptions: [...(r.assumptions ?? []), ...(r.sample ? [FICTIONAL_NOTE] : [])],
  };
}

// Ranks the catalog for the request's saved task and requirements and saves the top three, replacing
// the request's previous result (one row per request, so repeated runs never pile up rows).
async function computeAndStore(ctx: MutationCtx, request: Doc<"operatorRequests">) {
  const task = request.matchingInput!.task;
  const intent = intentFor(request, task);
  const robots = (await ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", task)).take(MAX_ROBOTS))
    .filter((r) => showSamples() || !r.sample);
  const notes = requirementsFor(request).notes;
  const picks = rankRobots(intent, robots.map(toFacts)).map((p) => ({
    ...p,
    robotId: p.robotId as Doc<"robots">["_id"],
    assumptions: [...p.assumptions, ...notes],
  }));
  const row = {
    requestId: request._id,
    status: "done" as const,
    intent: { task, searchPhrase: task, annualTaskCost: intent.annualTaskCost, budget: intent.budget, requirements: intent.requirements },
    picks,
    next: nextAction(intent, picks),
  };
  const latest = await latestRulesMatch(ctx, request._id);
  if (latest) {
    await ctx.db.patch(latest._id, { ...row, error: undefined, msToRanked: undefined });
    return latest._id;
  }
  return await ctx.db.insert("matches", { ...row, engine: "rules" as const });
}

// ---------- public functions (owner only) ----------

// Saves what to match on the Client's own request: the task, the requirements (can be empty) and,
// optionally, what the task costs per year. If that changed anything and a result already exists, the
// result is recomputed on the spot, so a stale one is never shown. Identical input changes nothing.
export const saveRequirements = mutation({
  args: {
    requestId: v.id("operatorRequests"),
    task: v.string(),
    requirements: v.array(requirementArg),
    annualTaskCost: v.optional(v.number()),
  },
  handler: async (ctx, { requestId, ...input }) => {
    const owned = await loadOwnedDraft(ctx, requestId);
    const { request, changed } = await applyInput(ctx, owned, input);
    const existing = await latestRulesMatch(ctx, requestId);
    const matchUpdated = changed && existing !== null;
    if (matchUpdated) await computeAndStore(ctx, request);
    return { changed, matchUpdated, matchId: existing?._id ?? null };
  },
});

// The saved matching input as the Client sees it, or null if none was saved.
// `requirements: null` means "derived from the follow-up answers" (as opposed to an empty list, which
// means "no requirements").
function savedView(request: Doc<"operatorRequests">) {
  const saved = request.matchingInput;
  if (!saved) return null;
  return {
    task: saved.task,
    requirements: saved.requirements ?? null,
    annualTaskCost: request.cost?.currentAnnualCost ?? null,
    updatedAt: saved.updatedAt,
  };
}

// The saved matching input for the caller's own request, or null if none was saved.
export const savedRequirements = query({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => savedView(await loadOwnedDraft(ctx, requestId)),
});

// Forgets the custom requirements on the caller's own request, so matching derives them from the
// follow-up answers again. The saved task and annual cost stay. If a result exists it is recomputed on
// the spot, so it never shows requirements that are gone. Calling it again (or when nothing custom was
// saved) changes nothing. An empty saved list counts as saved: it is cleared too.
export const clearRequirements = mutation({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    const existing = await latestRulesMatch(ctx, requestId);
    const saved = request.matchingInput;
    if (!saved || saved.requirements === undefined) {
      return { changed: false, matchUpdated: false, matchId: existing?._id ?? null };
    }
    await ctx.db.patch(requestId, { matchingInput: { task: saved.task, updatedAt: Date.now() } });
    const matchUpdated = existing !== null;
    if (matchUpdated) await computeAndStore(ctx, (await ctx.db.get(requestId))!);
    return { changed: true, matchUpdated, matchId: existing?._id ?? null };
  },
});

// Ranks the catalog's robots for the Client's own request and saves the top three under it. With no
// arguments beyond requestId it uses the saved input. Anything passed (task, requirements, annual cost)
// is saved first, exactly as saveRequirements would, so it needn't be sent again. Backward compatible
// with callers that always sent `task`.
export const findRobots = mutation({
  args: {
    requestId: v.id("operatorRequests"),
    task: v.optional(v.string()),
    annualTaskCost: v.optional(v.number()),
    requirements: v.optional(v.array(requirementArg)),
  },
  handler: async (ctx, { requestId, ...input }) => {
    const owned = await loadOwnedDraft(ctx, requestId);
    const { request } = await applyInput(ctx, owned, input);
    if (!request.matchingInput) throw new ConvexError("Save matching requirements first, or pass a task.");
    return await computeAndStore(ctx, request);
  },
});

// Where a robot's figure for one requirement comes from: a vendor page quote, a fictional sample
// figure, or not known at all.
function fitSource(r: Doc<"robots">, name: string): "vendor_spec" | "sample_figure" | "unknown" {
  const hasSpec = r.specs?.some((s) => s.name === name) ?? false;
  if (hasSpec) return r.sample ? "sample_figure" : "vendor_spec";
  if (name === "max_slope_deg" && r.slopeLimitDeg !== undefined) return r.sample ? "sample_figure" : "unknown";
  return "unknown";
}

// The request's latest result with each pick's robot details and where those numbers come from. `stale`
// is true if the request's inputs have changed since the result was made (e.g. a new annual cost or
// follow-up answer): run matching again. Null if none was run.
async function matchView(ctx: QueryCtx, request: Doc<"operatorRequests">) {
  const match = await latestRulesMatch(ctx, request._id);
  if (!match) return null;
  const sig = (i: Intent) => JSON.stringify([i.task, i.annualTaskCost, i.budget, i.requirements.map((r) => [r.name, r.op, r.value, r.mandatory])]);
  const mine = match.intent ? intentFor(request, request.matchingInput?.task ?? match.intent.task) : null;
  const stale = match.intent && mine
    ? sig(mine) !== sig({ task: match.intent.task, annualTaskCost: match.intent.annualTaskCost, budget: match.intent.budget, requirements: match.intent.requirements as Requirement[] })
    : false;
  const bases = requirementsFor(request).bases;
  const picks = [];
  for (const p of match.picks) {
    const r = await ctx.db.get(p.robotId);
    if (!r) continue;
    picks.push({
      ...p,
      name: r.name,
      vendor: r.vendor,
      url: r.url,
      price: r.priceStatus === "quote_only" ? null : r.price,
      specs: r.specs ?? [],
      fetchedAt: r.fetchedAt ?? null,
      dataSource: dataSourceOf(r),
      provenance: r.provenance ?? null,
      // aligned with intent.requirements: where this robot's figure for each requirement comes from
      fitSources: (match.intent?.requirements ?? []).map((q) => fitSource(r, q.name)),
    });
  }
  return {
    _id: match._id,
    status: match.status,
    intent: match.intent ?? null,
    // aligned with intent.requirements: "estimate" | "measured" (the Client's words) | "derived_from_answers"
    requirementBases: match.intent && !stale ? bases : null,
    next: match.next ?? null,
    stale,
    picks,
  };
}

// The caller's own latest result for a request (see matchView). Never reachable by another account.
export const latestMatch = query({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => matchView(ctx, await loadOwnedDraft(ctx, requestId)),
});

// Everything the page needs in one owner-only read: the saved matching input and the latest result,
// each exactly as savedRequirements and latestMatch return them. `state` says what to do next:
// "no_result" (nothing run yet), "stale" (inputs changed since the last run: run matching again) or
// "current".
export const overview = query({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    const match = await matchView(ctx, request);
    return {
      saved: savedView(request),
      match,
      state: match === null ? ("no_result" as const) : match.stale ? ("stale" as const) : ("current" as const),
    };
  },
});

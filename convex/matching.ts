import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { loadOwnedDraft } from "./lib/drafts";
import { nextAction, normalizeTask, rankRobots, type Intent, type Requirement, type RobotFacts } from "./lib/decide";
import { isSpecName } from "./lib/specs";

// "Find robots for me", the deterministic part: rank the catalog's robots for one of the
// signed-in Client's own requests with lib/decide.ts (plain code, no AI) and save the result
// under that request. Every function here goes through loadOwnedDraft, so only the owning Client
// can run it or read the result (lib/auth.ts, lib/drafts.ts). It calls no external service and
// schedules nothing; Claude, Apify and web search belong to the agent branch and stay off.
//
// Provenance is explicit on every result (see dataSourceOf): robots flagged `sample` are
// fictional demo data, robots read from a vendor page carry their quotes and source URLs, and
// anything else is marked unverified.

const FICTIONAL_NOTE =
  "Fictional sample robot: its price, running cost and automation share are illustrative, not vendor data.";
const SLOPE_NOTE = "Slope requirement comes from your follow-up answer, which is an illustrative figure.";
const MAX_REQUIREMENTS = 10;
const MAX_ROBOTS = 500;

const requirementArg = v.object({
  name: v.string(),
  op: v.union(v.literal("atLeast"), v.literal("atMost")),
  value: v.number(),
  mandatory: v.boolean(),
});

export type DataSource = "fictional_sample" | "vendor_sourced" | "unverified";

// Where a robot's numbers come from, from its stored row.
export function dataSourceOf(r: Doc<"robots">): DataSource {
  if (r.sample) return "fictional_sample";
  if (r.fetchedAt !== undefined && ((r.specs?.length ?? 0) > 0 || r.priceStatus !== undefined)) return "vendor_sourced";
  return "unverified";
}

function checkRequirements(raw: { name: string; op: "atLeast" | "atMost"; value: number; mandatory: boolean }[]): Requirement[] {
  if (raw.length > MAX_REQUIREMENTS) throw new ConvexError(`At most ${MAX_REQUIREMENTS} requirements allowed`);
  return raw.map((r) => {
    if (!isSpecName(r.name)) throw new ConvexError(`Unknown requirement: ${r.name.slice(0, 40)}`);
    if (!Number.isFinite(r.value) || r.value < 0 || r.value > 1e7) {
      throw new ConvexError("Requirement values must be non-negative numbers");
    }
    return { name: r.name, op: r.op, value: r.value, mandatory: r.mandatory };
  });
}

// With no requirements given, the slope follow-up answer (an illustrative number the page attaches
// to the chip) becomes a non-mandatory "handles at least this slope" requirement.
function requirementsFromAnswers(request: Doc<"operatorRequests">): Requirement[] {
  const slope = request.followUps?.find((f) => f.key === "slope")?.assumption?.value;
  return slope === undefined ? [] : [{ name: "max_slope_deg", op: "atLeast", value: slope, mandatory: false }];
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

// Ranks the catalog's robots for one task against the Client's own request and saves the top
// three under that request. Calling it again replaces the saved result, so repeated clicks never
// pile up rows. `annualTaskCost` (what the task costs them per year) is saved on the request.
export const findRobots = mutation({
  args: {
    requestId: v.id("operatorRequests"),
    task: v.string(),
    annualTaskCost: v.optional(v.number()),
    requirements: v.optional(v.array(requirementArg)),
  },
  handler: async (ctx, { requestId, task, annualTaskCost, requirements }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    const taskName = normalizeTask(task);
    if (taskName.length === 0 || taskName.length > 60) throw new ConvexError("task must be 1-60 characters");
    if (annualTaskCost !== undefined && !(Number.isFinite(annualTaskCost) && annualTaskCost > 0 && annualTaskCost < 100_000_000)) {
      throw new ConvexError("annualTaskCost must be a positive number of dollars");
    }
    const checked = requirements === undefined ? undefined : checkRequirements(requirements);

    let current = request;
    if (annualTaskCost !== undefined) {
      await ctx.db.patch(requestId, {
        cost: { ...(request.cost ?? { currency: "USD" }), currentAnnualCost: annualTaskCost },
        updatedAt: Date.now(),
      });
      current = (await ctx.db.get(requestId))!;
    }

    const derived = checked === undefined;
    const intent: Intent = {
      task: taskName,
      annualTaskCost: current.cost?.currentAnnualCost ?? null,
      budget: current.cost?.budget ?? null,
      requirements: checked ?? requirementsFromAnswers(current),
    };
    const robots = (await ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", taskName)).take(MAX_ROBOTS));
    const notes = derived && intent.requirements.length > 0 ? [SLOPE_NOTE] : [];
    const picks = rankRobots(intent, robots.map(toFacts)).map((p) => ({
      ...p,
      robotId: p.robotId as Doc<"robots">["_id"],
      assumptions: [...p.assumptions, ...notes],
    }));
    const row = {
      requestId,
      status: "done" as const,
      intent: { task: taskName, searchPhrase: taskName, annualTaskCost: intent.annualTaskCost, budget: intent.budget, requirements: intent.requirements },
      picks,
      next: nextAction(intent, picks),
    };
    const latest = await ctx.db.query("matches").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").first();
    if (latest) {
      await ctx.db.patch(latest._id, { ...row, error: undefined, msToRanked: undefined });
      return latest._id;
    }
    return await ctx.db.insert("matches", row);
  },
});

// The caller's own latest result for a request, each pick with its robot's details and where
// those numbers come from. Null if none was run. Never reachable by another account.
export const latestMatch = query({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
    const match = await ctx.db.query("matches").withIndex("by_request", (q) => q.eq("requestId", requestId)).order("desc").first();
    if (!match) return null;
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
      });
    }
    return { _id: match._id, status: match.status, intent: match.intent ?? null, next: match.next ?? null, picks };
  },
});

import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { loadOwnedDraft } from "./lib/drafts";
import { requireApprovedDeveloper } from "./lib/auth";
import { validateBountyPost } from "./lib/validation";

// Operator-posted bounties (status "posted", source "client"). AI-written drafts
// live in the same table but are private: see agent.ts. Money is illustrative.
// Posting and reading your own bounties needs the owning Client account; the
// public board needs an approved Developer account (lib/auth.ts).

// Posts the caller's bounty for one task, or updates it if they already posted
// for that task ("Edit my pledge"), so retries and double clicks never create a
// second bounty. Mutations are serializable, so the lookup-then-write is safe.
export const post = mutation({
  args: {
    requestId: v.id("operatorRequests"),
    taskKey: v.string(),
    title: v.string(),
    specLines: v.array(v.string()),
    gaps: v.array(v.string()),
    note: v.string(),
    industry: v.string(),
    pledgePercent: v.number(),
    pledged: v.number(),
    goal: v.number(),
  },
  handler: async (ctx, { requestId, ...input }) => {
    const request = await loadOwnedDraft(ctx, requestId);
    if (request.profile?.visibility === "anonymous") {
      throw new ConvexError(
        "Anonymous requests can't post shared bounties. Join the shared program first.",
      );
    }
    const clean = validateBountyPost(input);
    const fields = {
      ...clean,
      note: clean.note || undefined,
      region: request.profile?.region,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("bounties")
      .withIndex("by_request_task", (q) => q.eq("requestId", requestId).eq("taskKey", clean.taskKey))
      .filter((q) => q.eq(q.field("status"), "posted"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("bounties", {
      requestId, ownerId: request.ownerId, status: "posted", source: "client", ...fields,
    });
  },
});

// The caller's own posted bounties, newest first (used to restore the page).
export const getMine = query({
  args: { requestId: v.id("operatorRequests") },
  handler: async (ctx, { requestId }) => {
    await loadOwnedDraft(ctx, requestId);
    const rows = await ctx.db
      .query("bounties")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .order("desc")
      .collect();
    return rows.filter((b) => b.status === "posted");
  },
});

// What an approved developer may see. Deliberately excludes requestId and ownerId
// (which would let someone target the private draft or account), company
// identity, gaps and drafts.
function toPublic(b: Doc<"bounties">) {
  return {
    _id: b._id,
    _creationTime: b._creationTime,
    title: b.title,
    taskKey: b.taskKey,
    industry: b.industry,
    region: b.region,
    specLines: b.specLines ?? [],
    goal: b.goal,
    pledged: b.pledged,
  };
}

// The Developer board: posted bounties only, newest first. A reactive query, so
// a subscribed board updates as soon as a Client posts.
export const listPosted = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireApprovedDeveloper(ctx);
    const n = Math.min(Math.max(Math.floor(limit ?? 50), 1), 100);
    const rows = await ctx.db
      .query("bounties")
      .withIndex("by_status", (q) => q.eq("status", "posted"))
      .order("desc")
      .take(n);
    // A request switched to "anonymous" after posting takes its bounties off the board
    // (posting itself refuses anonymous requests). Reading the request also makes the
    // board update live when that happens.
    const visible = [];
    for (const b of rows) {
      const request = await ctx.db.get(b.requestId);
      if (request && request.profile?.visibility !== "anonymous") visible.push(b);
    }
    return visible.map(toPublic);
  },
});

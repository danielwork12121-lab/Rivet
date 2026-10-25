import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { costInfo, followUpAnswer, profileInfo } from "./schema";
import { validateFollowUps, validateRequestInput } from "./lib/validation";
import { DRAFT_NOT_FOUND, loadOwnedDraft, withoutToken } from "./lib/drafts";
import { requireClient } from "./lib/auth";

// Every public function here needs a signed-in Client and only touches that
// account's own requests (lib/auth.ts, lib/drafts.ts). No public function returns
// a token, an owner id, or another account's requests.

const intakeFields = {
  title: v.string(),
  description: v.string(),
  environment: v.string(),
  constraints: v.array(v.string()),
  cost: v.optional(costInfo),
  profile: v.optional(profileInfo),
};

// A Client submits a problem. Returns the request's id. If `clientToken` was
// already used by this account, returns that request's id and inserts nothing, so
// a retried or double-clicked submit can't create duplicates. Mutations are
// serializable, so the lookup-then-insert below can't race with a concurrent call.
export const create = mutation({
  args: { ...intakeFields, clientToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireClient(ctx);
    const clean = validateRequestInput(args);
    if (clean.clientToken !== undefined) {
      const token = clean.clientToken;
      const existing = await ctx.db
        .query("operatorRequests")
        .withIndex("by_client_token", (q) => q.eq("clientToken", token))
        .first();
      if (existing) {
        if (existing.ownerId !== user._id) {
          throw new ConvexError("This submission id is already in use. Reload the page and try again.");
        }
        return existing._id;
      }
    }
    return await ctx.db.insert("operatorRequests", {
      ...clean,
      ownerId: user._id,
      status: "submitted",
    });
  },
});

// Replaces the step 1 fields of the caller's own draft. Follow-up answers and
// status are left alone. Sending the same values again is harmless, so a
// timed-out update can simply be retried.
export const updateIntake = mutation({
  args: { id: v.id("operatorRequests"), ...intakeFields },
  handler: async (ctx, { id, ...intake }) => {
    await loadOwnedDraft(ctx, id);
    const clean = validateRequestInput(intake);
    await ctx.db.patch(id, {
      ...clean,
      cost: clean.cost, // explicit so an omitted cost/profile is removed, not kept
      profile: clean.profile,
      updatedAt: Date.now(),
    });
    return id;
  },
});

// Replaces the full set of follow-up answers on the caller's own draft.
// `complete` is the client's statement that every question was answered.
export const saveFollowUps = mutation({
  args: {
    id: v.id("operatorRequests"),
    answers: v.array(followUpAnswer),
    complete: v.boolean(),
  },
  handler: async (ctx, { id, answers, complete }) => {
    await loadOwnedDraft(ctx, id);
    await ctx.db.patch(id, {
      followUps: validateFollowUps(answers),
      followUpsComplete: complete,
      updatedAt: Date.now(),
    });
    return id;
  },
});

// The caller's own draft, without its token. Throws "Draft not found" for an
// unknown id or someone else's request.
export const getDraft = query({
  args: { id: v.id("operatorRequests") },
  handler: async (ctx, { id }) => withoutToken(await loadOwnedDraft(ctx, id)),
});

// The caller's own requests, most recently created first.
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const user = await requireClient(ctx);
    const n = Math.min(Math.max(Math.floor(limit ?? 20), 1), 50);
    const rows = await ctx.db
      .query("operatorRequests")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .order("desc")
      .take(n);
    return rows.map(withoutToken);
  },
});

// Moves a draft saved before accounts existed (protected only by the browser's
// clientToken) into the caller's account, together with its bounties. Works once:
// a draft that already has an owner is "not found" to everyone else, and the token
// grants nothing afterwards.
export const claimLegacyDraft = mutation({
  args: { id: v.id("operatorRequests"), clientToken: v.string() },
  handler: async (ctx, { id, clientToken }) => {
    const user = await requireClient(ctx);
    const doc = await ctx.db.get(id);
    if (!doc || doc.clientToken === undefined || doc.clientToken !== clientToken) {
      throw new ConvexError(DRAFT_NOT_FOUND);
    }
    if (doc.ownerId === user._id) return id;
    if (doc.ownerId !== undefined) throw new ConvexError(DRAFT_NOT_FOUND);
    await ctx.db.patch(id, { ownerId: user._id });
    const bounties = await ctx.db
      .query("bounties")
      .withIndex("by_request", (q) => q.eq("requestId", id))
      .collect();
    for (const b of bounties) await ctx.db.patch(b._id, { ownerId: user._id });
    return id;
  },
});

// ---- internal only: not callable from browsers ---------------------------------
// Kept for server-side use (e.g. a future AI extraction action) and tests.

// Newest first. `limit` is capped so the response stays small.
export const list = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = Math.min(Math.max(Math.floor(limit ?? 50), 1), 100);
    return await ctx.db.query("operatorRequests").order("desc").take(n);
  },
});

// Returns the request, or null if the id doesn't exist.
export const get = internalQuery({
  args: { id: v.id("operatorRequests") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

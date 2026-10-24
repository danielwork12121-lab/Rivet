import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { costInfo, followUpAnswer, profileInfo } from "./schema";
import { validateFollowUps, validateRequestInput } from "./lib/validation";
import { loadOwnedDraft, withoutToken } from "./lib/drafts";

// The browser generates each draft's `clientToken`, keeps it in localStorage,
// and must send it to read or change the draft (see lib/drafts.ts). No public
// function returns a token or lists other operators' requests.

const intakeFields = {
  title: v.string(),
  description: v.string(),
  environment: v.string(),
  constraints: v.array(v.string()),
  cost: v.optional(costInfo),
  profile: v.optional(profileInfo),
};

// Operator submits a problem. Returns the request's id. If `clientToken` was
// already used, returns that request's id and inserts nothing, so a retried or
// double-clicked submit can't create duplicates. Mutations are serializable, so
// the lookup-then-insert below can't race with a concurrent call.
export const create = mutation({
  args: { ...intakeFields, clientToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const clean = validateRequestInput(args);
    if (clean.clientToken !== undefined) {
      const token = clean.clientToken;
      const existing = await ctx.db
        .query("operatorRequests")
        .withIndex("by_client_token", (q) => q.eq("clientToken", token))
        .first();
      if (existing) return existing._id;
    }
    return await ctx.db.insert("operatorRequests", {
      ...clean,
      status: "submitted",
    });
  },
});

// Replaces the step 1 fields of the caller's own draft. Follow-up answers and
// status are left alone. Sending the same values again is harmless, so a
// timed-out update can simply be retried.
export const updateIntake = mutation({
  args: { id: v.id("operatorRequests"), clientToken: v.string(), ...intakeFields },
  handler: async (ctx, { id, clientToken, ...intake }) => {
    await loadOwnedDraft(ctx, id, clientToken);
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
    clientToken: v.string(),
    answers: v.array(followUpAnswer),
    complete: v.boolean(),
  },
  handler: async (ctx, { id, clientToken, answers, complete }) => {
    await loadOwnedDraft(ctx, id, clientToken);
    await ctx.db.patch(id, {
      followUps: validateFollowUps(answers),
      followUpsComplete: complete,
      updatedAt: Date.now(),
    });
    return id;
  },
});

// The caller's own draft, without its token. Throws "Draft not found" for an
// unknown id or a wrong token.
export const getDraft = query({
  args: { id: v.id("operatorRequests"), clientToken: v.string() },
  handler: async (ctx, { id, clientToken }) =>
    withoutToken(await loadOwnedDraft(ctx, id, clientToken)),
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

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { costInfo, profileInfo } from "./schema";
import { validateRequestInput } from "./lib/validation";

// Operator submits a problem. Returns the request's id. If `clientToken` was
// already used, returns that request's id and inserts nothing, so a retried or
// double-clicked submit can't create duplicates. Mutations are serializable, so
// the lookup-then-insert below can't race with a concurrent call.
export const create = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    environment: v.string(),
    constraints: v.array(v.string()),
    cost: v.optional(costInfo),
    profile: v.optional(profileInfo),
    clientToken: v.optional(v.string()),
  },
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

// Newest first. `limit` is capped so the response stays small.
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = Math.min(Math.max(Math.floor(limit ?? 50), 1), 100);
    return await ctx.db.query("operatorRequests").order("desc").take(n);
  },
});

// Returns the request, or null if the id doesn't exist.
export const get = query({
  args: { id: v.id("operatorRequests") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

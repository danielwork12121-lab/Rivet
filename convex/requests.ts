import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { costInfo } from "./schema";
import { validateRequestInput } from "./lib/validation";

// Operator submits a problem. Returns the new request's id.
export const create = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    environment: v.string(),
    constraints: v.array(v.string()),
    cost: v.optional(costInfo),
  },
  handler: async (ctx, args) => {
    const clean = validateRequestInput(args);
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

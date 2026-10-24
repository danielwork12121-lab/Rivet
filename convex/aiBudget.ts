import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { budgetBlock } from "./lib/aiBudget";

// Called by the Vercel /api/chat function, server to server, before each paid chat
// call. Not for browsers: it requires RIVET_SERVER_SECRET, which lives only in the
// Convex and Vercel environments. Without it configured, chat stays off.
export const reserveChat = mutation({
  args: { secret: v.string(), clientKey: v.string() },
  handler: async (ctx, { secret, clientKey }) => {
    const expected = process.env.RIVET_SERVER_SECRET;
    if (!expected || secret !== expected) throw new ConvexError("forbidden");
    if (!/^[a-f0-9]{32,128}$/.test(clientKey)) throw new ConvexError("invalid client key");
    const block = await budgetBlock(ctx, { clientKey });
    if (block) return { ok: false as const, reason: block };
    await ctx.db.insert("aiUsage", { kind: "chat", clientKey });
    return { ok: true as const };
  },
});

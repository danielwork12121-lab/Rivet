import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { budgetBlock } from "./lib/aiBudget";
import { getViewer } from "./lib/auth";

// Called by the Vercel /api/chat function, server to server, before each paid chat
// call. Not for browsers: it requires RIVET_SERVER_SECRET, which lives only in the
// Convex and Vercel environments. Without it configured, chat stays off.
// /api/chat forwards the visitor's Clerk session token, so Convex itself verifies
// who is asking: only a signed-in Client account may spend chat budget.
export const reserveChat = mutation({
  args: { secret: v.string(), clientKey: v.string() },
  handler: async (ctx, { secret, clientKey }) => {
    const expected = process.env.RIVET_SERVER_SECRET;
    if (!expected || secret !== expected) throw new ConvexError("forbidden");
    if (!/^[a-f0-9]{32,128}$/.test(clientKey)) throw new ConvexError("invalid client key");
    if (!(await ctx.auth.getUserIdentity())) return { ok: false as const, reason: "unauthenticated" as const };
    const user = await getViewer(ctx);
    if (!user || !user.role) return { ok: false as const, reason: "no_account" as const };
    if (user.role !== "client") return { ok: false as const, reason: "not_client" as const };
    const block = await budgetBlock(ctx, { clientKey, userId: user._id });
    if (block) return { ok: false as const, reason: block };
    await ctx.db.insert("aiUsage", { kind: "chat", clientKey, userId: user._id });
    return { ok: true as const };
  },
});

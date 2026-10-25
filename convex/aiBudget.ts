import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { budgetBlock } from "./lib/aiBudget";
import { getViewer } from "./lib/auth";

// Called by the Vercel functions /api/chat and /api/analyze-video, server to server,
// before each paid call. Not for browsers: it requires RIVET_SERVER_SECRET, which lives
// only in the Convex and Vercel environments. Without it configured, those stay off.
// The functions forward the visitor's Clerk session token, so Convex itself verifies
// who is asking: only a signed-in Client account may spend budget. The check and the
// usage row happen in one mutation, so concurrent callers can't both take the last unit.
async function reserve(ctx: MutationCtx, kind: "chat" | "video", secret: string, clientKey: string) {
  const expected = process.env.RIVET_SERVER_SECRET;
  if (!expected || secret !== expected) throw new ConvexError("forbidden");
  if (!/^[a-f0-9]{32,128}$/.test(clientKey)) throw new ConvexError("invalid client key");
  if (!(await ctx.auth.getUserIdentity())) return { ok: false as const, reason: "unauthenticated" as const };
  const user = await getViewer(ctx);
  if (!user || !user.role) return { ok: false as const, reason: "no_account" as const };
  if (user.role !== "client") return { ok: false as const, reason: "not_client" as const };
  const block = await budgetBlock(ctx, { clientKey, userId: user._id, kind });
  if (block) return { ok: false as const, reason: block };
  await ctx.db.insert("aiUsage", { kind, clientKey, userId: user._id });
  return { ok: true as const };
}

export const reserveChat = mutation({
  args: { secret: v.string(), clientKey: v.string() },
  handler: (ctx, { secret, clientKey }) => reserve(ctx, "chat", secret, clientKey),
});

export const reserveVideo = mutation({
  args: { secret: v.string(), clientKey: v.string() },
  handler: (ctx, { secret, clientKey }) => reserve(ctx, "video", secret, clientKey),
});

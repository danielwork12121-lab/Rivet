import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// Access model: Clerk proves who is calling (Convex verifies the session token
// against auth.config.ts); the users table says what they may do. A role is read
// only from that row, never from anything the browser sends (arguments, URLs,
// storage, email domains). Every protected public function calls one of the
// require* helpers below before reading or changing anything.

// Error texts reach the browser as err.data; js/rivet-api.js matches on them.
export const NOT_SIGNED_IN = "Please sign in to continue.";
export const NO_ACCOUNT = "Finish setting up your account first.";
export const CLIENT_ONLY = "This needs a Client account.";
export const DEVELOPER_ONLY = "This needs an approved Developer account.";

// The caller's account, or null if they aren't signed in or have no row yet.
export async function getViewer(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

// Signed in, with an account whose role has been chosen.
export async function requireAccount(ctx: QueryCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError(NOT_SIGNED_IN);
  const user = await getViewer(ctx);
  if (!user || !user.role) throw new ConvexError(NO_ACCOUNT);
  return user;
}

export async function requireClient(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireAccount(ctx);
  if (user.role !== "client") throw new ConvexError(CLIENT_ONLY);
  return user;
}

export const isApprovedDeveloper = (u: Doc<"users">) =>
  u.role === "developer" && u.developerStatus === "approved";

export async function requireApprovedDeveloper(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireAccount(ctx);
  if (!isApprovedDeveloper(user)) throw new ConvexError(DEVELOPER_ONLY);
  return user;
}

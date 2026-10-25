import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { developerStatus, role } from "./schema";
import { NOT_SIGNED_IN, getViewer, isApprovedDeveloper } from "./lib/auth";

// Accounts and roles (see lib/auth.ts for how they are enforced).
//
// Onboarding: after Clerk signs someone in, the page calls ensureAccount, then
// chooseRole once. "client" takes effect at once. "developer" starts pending:
// Developer-only functions refuse until an admin approves the account
// (setDeveloperStatus) or the person redeems a single-use invite code
// (createDeveloperInvite -> redeemDeveloperInvite). A role can't be changed from
// a browser after it is chosen, so a Client can never make itself a Developer.

const TEXT_MAX = 100;
const INVITE_CODE = /^[A-Za-z0-9_-]{16,100}$/;
const INVITE_INVALID = "That invite code isn't valid or has expired.";
const DAY_MS = 24 * 60 * 60 * 1000;

// What the browser may know about its own account.
function toAccount(u: Doc<"users">) {
  return {
    role: u.role ?? null,
    developerStatus: u.developerStatus ?? null,
    approvedDeveloper: isApprovedDeveloper(u),
    email: u.email ?? null,
    name: u.name ?? null,
    organization: u.organization ?? null,
  };
}

function optionalText(label: string, value: string | undefined) {
  const t = value?.trim();
  if (!t) return undefined;
  if (t.length > TEXT_MAX) throw new ConvexError(`${label} must be at most ${TEXT_MAX} characters`);
  return t;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The caller's row, created from the verified token if missing. Throws if signed out.
async function upsertViewer(ctx: MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError(NOT_SIGNED_IN);
  const existing = await getViewer(ctx);
  const fromToken = {
    clerkUserId: identity.subject,
    ...(identity.email ? { email: identity.email } : {}),
  };
  if (existing) {
    if (identity.email && identity.email !== existing.email) {
      await ctx.db.patch(existing._id, { email: identity.email, updatedAt: Date.now() });
      return { ...existing, email: identity.email };
    }
    return existing;
  }
  const id = await ctx.db.insert("users", {
    tokenIdentifier: identity.tokenIdentifier,
    ...fromToken,
    ...(identity.name ? { name: identity.name.slice(0, TEXT_MAX) } : {}),
  });
  return (await ctx.db.get(id))!;
}

// Valid, unused, unexpired invite for this code, or null.
async function findInvite(ctx: MutationCtx, code: string) {
  if (!INVITE_CODE.test(code)) return null;
  const codeHash = await sha256Hex(code);
  const invite = await ctx.db
    .query("developerInvites")
    .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
    .unique();
  return invite && !invite.usedBy && invite.expiresAt > Date.now() ? invite : null;
}

// ---------- public ----------

// Who is signed in, as Convex sees it. `account` is null until ensureAccount ran;
// `account.role` is null until chooseRole ran.
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { signedIn: false as const, account: null };
    const user = await getViewer(ctx);
    return { signedIn: true as const, account: user && toAccount(user) };
  },
});

// Creates the caller's account on first sign-in; safe to call on every sign-in.
export const ensureAccount = mutation({
  args: {},
  handler: async (ctx) => toAccount(await upsertViewer(ctx)),
});

// Sets the caller's role once. Repeating the same choice is harmless (retries);
// a different role is refused. A valid invite code approves a developer at once.
export const chooseRole = mutation({
  args: {
    role,
    name: v.optional(v.string()),
    organization: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await upsertViewer(ctx);
    if (user.role && user.role !== args.role) {
      throw new ConvexError("Your account type is already set. Contact Rivet to change it.");
    }
    const name = optionalText("name", args.name);
    const organization = optionalText("organization", args.organization);
    const patch: Partial<Doc<"users">> = {
      role: args.role,
      ...(name ? { name } : {}),
      ...(organization ? { organization } : {}),
      updatedAt: Date.now(),
    };
    if (args.role === "developer" && !user.developerStatus) patch.developerStatus = "pending";
    await ctx.db.patch(user._id, patch);
    if (args.role === "developer" && args.inviteCode && (user.developerStatus ?? "pending") === "pending") {
      const invite = await findInvite(ctx, args.inviteCode.trim());
      if (!invite) throw new ConvexError(INVITE_INVALID);
      await ctx.db.patch(invite._id, { usedBy: user._id, usedAt: Date.now() });
      await ctx.db.patch(user._id, { developerStatus: "approved" });
    }
    return toAccount((await ctx.db.get(user._id))!);
  },
});

// A pending developer redeems a single-use invite code to become approved.
export const redeemDeveloperInvite = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await upsertViewer(ctx);
    if (user.role !== "developer") throw new ConvexError("Invite codes are for Developer accounts.");
    if (user.developerStatus === "approved") return toAccount(user);
    if (user.developerStatus !== "pending") throw new ConvexError(INVITE_INVALID); // revoked
    const invite = await findInvite(ctx, code.trim());
    if (!invite) throw new ConvexError(INVITE_INVALID);
    await ctx.db.patch(invite._id, { usedBy: user._id, usedAt: Date.now() });
    await ctx.db.patch(user._id, { developerStatus: "approved", updatedAt: Date.now() });
    return toAccount((await ctx.db.get(user._id))!);
  },
});

// ---------- admin: CLI only (internal) ----------
//   npx convex run users:list '{"developerStatus":"pending"}'
//   npx convex run users:setDeveloperStatus '{"clerkUserId":"user_...","status":"approved"}'
//   npx convex run users:createDeveloperInvite '{"note":"Bayline Robotics","days":7}'

export const list = internalQuery({
  args: { role: v.optional(role), developerStatus: v.optional(developerStatus) },
  handler: async (ctx, args) => {
    const status = args.developerStatus;
    const rows = status
      ? await ctx.db.query("users").withIndex("by_developer_status", (q) => q.eq("developerStatus", status)).order("desc").take(500)
      : await ctx.db.query("users").order("desc").take(500);
    return rows
      .filter((u) => !args.role || u.role === args.role)
      .map((u) => ({ clerkUserId: u.clerkUserId, ...toAccount(u), createdAt: u._creationTime }));
  },
});

export const setDeveloperStatus = internalMutation({
  args: { clerkUserId: v.string(), status: developerStatus },
  handler: async (ctx, { clerkUserId, status }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!user) throw new ConvexError(`No account for ${clerkUserId}`);
    if (user.role !== "developer") throw new ConvexError("That account is not a Developer account.");
    await ctx.db.patch(user._id, { developerStatus: status, updatedAt: Date.now() });
    return toAccount({ ...user, developerStatus: status });
  },
});

// An action, not a mutation, so the code comes from real randomness. Prints the
// code once; only its hash is stored.
export const createDeveloperInvite = internalAction({
  args: { note: v.optional(v.string()), days: v.optional(v.number()) },
  handler: async (ctx, { note, days }) => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const code = "rivet-dev-" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
    const valid = Math.min(Math.max(days ?? 7, 1), 30);
    await ctx.runMutation(internal.users.storeInvite, {
      codeHash: await sha256Hex(code),
      ...(note ? { note: note.slice(0, 200) } : {}),
      expiresAt: Date.now() + valid * DAY_MS,
    });
    return { code, expiresInDays: valid };
  },
});

export const storeInvite = internalMutation({
  args: { codeHash: v.string(), note: v.optional(v.string()), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("developerInvites", args);
  },
});

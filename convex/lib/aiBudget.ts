import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Server-enforced limits on paid AI calls. Every path that starts a paid call
// (spec, recommend, bounty brief, website chat) checks these first and records
// one aiUsage row. Every path also requires a signed-in Client (lib/auth.ts).
// The global daily cap is the hard guarantee; the per-request, per-account and
// hashed-visitor limits spread the budget fairly.
//
// Convex env vars (whole numbers >= 0; unset = default; anything else = 0, i.e. off):
//   AI_DAILY_LIMIT          all paid AI calls in the last 24 h     (default 25)
//   AI_REQUEST_DAILY_LIMIT  per operator request in the last 24 h  (default 3)
//   AI_CLIENT_DAILY_LIMIT   per website visitor in the last 24 h   (default 10)
//   AI_USER_DAILY_LIMIT     per signed-in account in the last 24 h (default 10)

const DAY_MS = 24 * 60 * 60 * 1000;

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0; // misconfigured: fail closed
}

export const aiLimits = () => ({
  daily: limit("AI_DAILY_LIMIT", 25),
  perRequest: limit("AI_REQUEST_DAILY_LIMIT", 3),
  perClient: limit("AI_CLIENT_DAILY_LIMIT", 10),
  perUser: limit("AI_USER_DAILY_LIMIT", 10),
});

export type AiBlock = "daily_limit" | "request_limit" | "client_limit" | "user_limit";

export const AI_BLOCK_MESSAGES: Record<AiBlock, string> = {
  daily_limit: "The demo's AI budget for today has been used up. Please try again tomorrow.",
  request_limit: "This request has reached its AI limit for today.",
  client_limit: "You've reached today's AI limit for this demo.",
  user_limit: "Your account has reached today's AI limit for this demo.",
};

type Scope = { requestId?: Id<"operatorRequests">; clientKey?: string; userId?: Id<"users"> };

// Which limit (if any) blocks a new paid call for this scope.
export async function budgetBlock(ctx: QueryCtx, scope: Scope = {}): Promise<AiBlock | null> {
  const lim = aiLimits();
  const recent = await ctx.db
    .query("aiUsage")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - DAY_MS))
    .collect();
  if (recent.length >= lim.daily) return "daily_limit";
  if (scope.requestId && recent.filter((u) => u.requestId === scope.requestId).length >= lim.perRequest) {
    return "request_limit";
  }
  if (scope.clientKey && recent.filter((u) => u.clientKey === scope.clientKey).length >= lim.perClient) {
    return "client_limit";
  }
  if (scope.userId && recent.filter((u) => u.userId === scope.userId).length >= lim.perUser) {
    return "user_limit";
  }
  return null;
}

// Checks the limits and records one paid call, or throws a ConvexError whose
// message is safe to show. Mutations are serializable, so concurrent callers
// can't both take the last unit of budget.
export async function spendAiBudget(
  ctx: MutationCtx,
  kind: "spec" | "recommend" | "bounty" | "chat",
  scope: Scope = {},
) {
  const block = await budgetBlock(ctx, scope);
  if (block) throw new ConvexError(AI_BLOCK_MESSAGES[block]);
  await ctx.db.insert("aiUsage", { kind, ...scope });
}

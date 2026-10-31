import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { env } from "./env";

// Server-enforced limits on paid AI calls. Every path that starts a paid call
// (spec, recommend, bounty brief, website chat) checks these first and records
// one aiUsage row. Every path also requires a signed-in Client (lib/auth.ts).
// The global daily cap is the hard guarantee; the per-request, per-account and
// hashed-visitor limits spread the budget fairly.
//
// Convex env vars (whole numbers >= 0, surrounding whitespace ignored; unset = default;
// anything else = 0, i.e. off):
//   AI_DAILY_LIMIT          all paid AI calls in the last 24 h     (default 25)
//   AI_REQUEST_DAILY_LIMIT  per operator request in the last 24 h  (default 3)
//   AI_CLIENT_DAILY_LIMIT   per website visitor in the last 24 h   (default 10)
//   AI_USER_DAILY_LIMIT     per signed-in account in the last 24 h (default 10)
//   VIDEO_DAILY_LIMIT       video analyses (Gemini) in the last 24 h (default 10)
//   VIDEO_USER_DAILY_LIMIT  video analyses per signed-in account     (default 3)
//   DISCOVERY_DAILY_LIMIT   Apify web searches in the last 24 h      (default 3)
//   DISCOVERY_USER_DAILY_LIMIT  web searches per signed-in account    (default 1)
// A video analysis, an AI matching run and a web search each also count toward the
// all-kinds limits above.

const DAY_MS = 24 * 60 * 60 * 1000;

function limit(name: string, fallback: number): number {
  if (process.env[name] === undefined || process.env[name] === "") return fallback;
  const raw = env(name); // " 5\n" reads as 5; whitespace only reads as "" and fails closed below
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0; // misconfigured: fail closed
}

export const aiLimits = () => ({
  daily: limit("AI_DAILY_LIMIT", 25),
  perRequest: limit("AI_REQUEST_DAILY_LIMIT", 3),
  perClient: limit("AI_CLIENT_DAILY_LIMIT", 10),
  perUser: limit("AI_USER_DAILY_LIMIT", 10),
  video: limit("VIDEO_DAILY_LIMIT", 10),
  videoPerUser: limit("VIDEO_USER_DAILY_LIMIT", 3),
  discovery: limit("DISCOVERY_DAILY_LIMIT", 3),
  discoveryPerUser: limit("DISCOVERY_USER_DAILY_LIMIT", 1),
});

export type AiBlock =
  | "daily_limit" | "request_limit" | "client_limit" | "user_limit"
  | "video_limit" | "video_user_limit" | "discovery_limit" | "discovery_user_limit";

export const AI_BLOCK_MESSAGES: Record<AiBlock, string> = {
  daily_limit: "The demo's AI budget for today has been used up. Please try again tomorrow.",
  request_limit: "This request has reached its AI limit for today.",
  client_limit: "You've reached today's AI limit for this demo.",
  user_limit: "Your account has reached today's AI limit for this demo.",
  video_limit: "The demo's video analysis budget for today has been used up. Please try again tomorrow.",
  video_user_limit: "Your account has reached today's video analysis limit for this demo.",
  discovery_limit: "The demo's web search budget for today has been used up.",
  discovery_user_limit: "Your account has reached today's web search limit for this demo.",
};

type Scope = { requestId?: Id<"operatorRequests">; clientKey?: string; userId?: Id<"users"> };
type Kind = "spec" | "recommend" | "bounty" | "chat" | "video" | "match" | "discovery";

// Which limit (if any) blocks a new paid call for this scope.
// `kind: "video"` adds the video-specific limits on top of the all-kinds ones.
export async function budgetBlock(ctx: QueryCtx, scope: Scope & { kind?: Kind } = {}): Promise<AiBlock | null> {
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
  if (scope.kind === "video") {
    const videos = recent.filter((u) => u.kind === "video");
    if (videos.length >= lim.video) return "video_limit";
    if (scope.userId && videos.filter((u) => u.userId === scope.userId).length >= lim.videoPerUser) {
      return "video_user_limit";
    }
  }
  if (scope.kind === "discovery") {
    const searches = recent.filter((u) => u.kind === "discovery");
    if (searches.length >= lim.discovery) return "discovery_limit";
    if (scope.userId && searches.filter((u) => u.userId === scope.userId).length >= lim.discoveryPerUser) {
      return "discovery_user_limit";
    }
  }
  return null;
}

// Checks the limits and records one paid call, or throws a ConvexError whose
// message is safe to show. Mutations are serializable, so concurrent callers
// can't both take the last unit of budget.
export async function spendAiBudget(
  ctx: MutationCtx,
  kind: Kind,
  scope: Scope = {},
) {
  const block = await budgetBlock(ctx, { ...scope, kind });
  if (block) throw new ConvexError(AI_BLOCK_MESSAGES[block]);
  await ctx.db.insert("aiUsage", { kind, ...scope });
}

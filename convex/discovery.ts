import { v } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { normalizeTask } from "./lib/decide";
import { AI_BLOCK_MESSAGES, budgetBlock } from "./lib/aiBudget";
import { requireClient } from "./lib/auth";
import { env } from "./lib/env";
import { SEARCH_OFF_NOTE, failedSearchNote } from "./lib/searchNote";

// Database side of the web search for robots. The Apify calls live in scrape.ts
// and the extraction in ai.ts; these functions track progress and store pages.

const RECENT_MS = 7 * 24 * 60 * 60 * 1000; // don't search the same task twice in a week
export const STUCK_MS = 15 * 60 * 1000; // a search older than this has crashed (maintenance.sweepStuck ends it)

// A new web search costs Apify (and Claude, which reads the pages), so it is off unless
// DISCOVERY_ENABLED=true and APIFY_TOKEN are set, and each one spends a unit of a small daily
// budget charged to the account whose match asked for it (lib/aiBudget.ts). The check and the
// usage row are in this one mutation, so concurrent matches can't both take the last unit.
const discoveryEnabled = () => env("DISCOVERY_ENABLED") === "true" && !!env("APIFY_TOKEN");
// The operator sees a neutral note; the setup hint is for developers, in the Convex logs only.
const DISCOVERY_OFF_LOG = "web search skipped: discovery is off (needs DISCOVERY_ENABLED=true and APIFY_TOKEN)";

// Tells the match why it went on without a web search, so the page can say so.
async function noteSkipped(ctx: MutationCtx, matchId: Id<"matches"> | undefined, note: string) {
  if (matchId && (await ctx.db.get(matchId))) await ctx.db.patch(matchId, { searchNote: note });
}

// Starts a search for `task`, or joins the one already running.
// Returns "run" (started), "wait" (joined a running one), "done" (searched recently) or
// "blocked" (searching is off, or a daily limit is reached: the match goes on without one).
export const start = internalMutation({
  args: { task: v.string(), searchPhrase: v.string(), matchId: v.optional(v.id("matches")) },
  handler: async (ctx, { task, searchPhrase, matchId }) => {
    if (!discoveryEnabled()) {
      console.log(DISCOVERY_OFF_LOG);
      await noteSkipped(ctx, matchId, SEARCH_OFF_NOTE);
      return "blocked" as const;
    }
    const key = normalizeTask(task);
    const existing = await ctx.db.query("discoveries").withIndex("by_task", (q) => q.eq("task", key)).first();
    const waiting = matchId ? [matchId] : [];
    if (existing) {
      const running = existing.status !== "done" && existing.status !== "failed";
      const lastTouched = existing.finishedAt ?? existing._creationTime;
      if (running && Date.now() - existing._creationTime < STUCK_MS) {
        await ctx.db.patch(existing._id, { waitingMatches: [...existing.waitingMatches, ...waiting] });
        return "wait";
      }
      // Only a search whose robots are still filed under this task counts; a failed or empty one
      // is retried. (A robot page found again under another task name moves to that task.)
      const found = existing.status === "done" && existing.robotsFound > 0 &&
        (await ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", key)).collect()).some((r) => !r.sample);
      if (found && Date.now() - lastTouched < RECENT_MS) return "done";
    }
    // A new, paid search: charge it to the account behind the match, if there is one.
    const match = matchId ? await ctx.db.get(matchId) : null;
    const request = match ? await ctx.db.get(match.requestId) : null;
    const scope = { kind: "discovery" as const, ...(request?.ownerId ? { userId: request.ownerId } : {}) };
    const block = await budgetBlock(ctx, scope);
    if (block) {
      await noteSkipped(ctx, matchId, `Web search skipped: ${AI_BLOCK_MESSAGES[block]}`);
      return "blocked" as const;
    }
    await ctx.db.insert("aiUsage", { kind: "discovery", ...(scope.userId ? { userId: scope.userId } : {}) });
    // Stale or stuck: start over, keeping any matches still waiting on the old search.
    const carried = existing ? existing.waitingMatches.filter((id) => !waiting.includes(id)) : [];
    if (existing) await ctx.db.delete(existing._id);
    const discoveryId = await ctx.db.insert("discoveries", {
      task: key, searchPhrase, status: "searching", urls: [], robotsFound: 0, waitingMatches: [...carried, ...waiting],
    });
    await ctx.scheduler.runAfter(0, internal.scrape.discover, { discoveryId });
    return "run";
  },
});

// For scrape:crawlUrls: a search with hand-picked URLs instead of Google results.
export const startManual = internalMutation({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const key = normalizeTask(task);
    const existing = await ctx.db.query("discoveries").withIndex("by_task", (q) => q.eq("task", key)).first();
    const waitingMatches = existing?.waitingMatches ?? [];
    if (existing) await ctx.db.delete(existing._id);
    return await ctx.db.insert("discoveries", {
      task: key, searchPhrase: key, status: "crawling", urls: [], robotsFound: 0, waitingMatches,
    });
  },
});

export const get = internalQuery({
  args: { discoveryId: v.id("discoveries") },
  handler: async (ctx, { discoveryId }) => ctx.db.get(discoveryId),
});

export const setStatus = internalMutation({
  args: {
    discoveryId: v.id("discoveries"),
    status: v.union(v.literal("searching"), v.literal("crawling"), v.literal("extracting")),
    urls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { discoveryId, ...patch }) => {
    await ctx.db.patch(discoveryId, patch);
  },
});

// Saves a crawled page, replacing an older copy of the same URL.
export const savePage = internalMutation({
  args: {
    discoveryId: v.id("discoveries"), url: v.string(), title: v.string(), markdown: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, page) => {
    const old = await ctx.db.query("pages").withIndex("by_url", (q) => q.eq("url", page.url)).first();
    if (old) await ctx.db.delete(old._id);
    await ctx.db.insert("pages", { ...page, extracted: false, fetchedAt: Date.now() });
  },
});

export const pagesToExtract = internalQuery({
  args: { discoveryId: v.id("discoveries") },
  handler: async (ctx, { discoveryId }) =>
    (await ctx.db.query("pages").withIndex("by_discovery", (q) => q.eq("discoveryId", discoveryId)).collect())
      .filter((p) => !p.extracted),
});

export const markExtracted = internalMutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, { pageId }) => {
    await ctx.db.patch(pageId, { extracted: true });
  },
});

// Ends a search and re-runs every match that was waiting for it.
export const finish = internalMutation({
  args: {
    discoveryId: v.id("discoveries"),
    status: v.union(v.literal("done"), v.literal("failed")),
    robotsFound: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { discoveryId, ...result }) => finishDiscovery(ctx, discoveryId, result),
});

type SearchResult = { status: "done" | "failed"; robotsFound: number; error?: string };

// Shared by finish and maintenance.sweepStuck (a search that crashed or ran out of time).
export async function finishDiscovery(ctx: MutationCtx, discoveryId: Id<"discoveries">, result: SearchResult) {
  const d = await ctx.db.get(discoveryId);
  if (!d) return;
  // A late finish after the sweeper gave up: keep the robots it saved, nobody is waiting any more.
  const lateFinish = (d.status === "done" || d.status === "failed") && d.waitingMatches.length === 0;
  await ctx.db.patch(discoveryId, { ...result, waitingMatches: [], finishedAt: Date.now() });
  if (lateFinish) return;
  // Tell each waiting match how the search went, so an empty result isn't read as "no product".
  const note = result.status === "failed"
    ? failedSearchNote(result.error)
    : result.robotsFound === 0 ? `The web search for "${d.task}" robots read the pages it found but none described a robot.` : null;
  for (const matchId of d.waitingMatches) {
    if (note && (await ctx.db.get(matchId))) await ctx.db.patch(matchId, { searchNote: note });
    await ctx.scheduler.runAfter(0, internal.ai.matchRobots, { matchId, searched: true });
  }
}

// For the page: is a search running for this task, and what has it found? Signed-in Clients
// only, so what other operators asked to search for isn't public.
export const forTask = query({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    await requireClient(ctx);
    const d = await ctx.db.query("discoveries").withIndex("by_task", (q) => q.eq("task", normalizeTask(task))).first();
    return d && { task: d.task, status: d.status, urls: d.urls, robotsFound: d.robotsFound };
  },
});

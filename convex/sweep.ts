import { internalMutation } from "./_generated/server";
import { finishDiscovery, STUCK_MS } from "./discovery";

// Ends work that crashed or ran out of time, so the page never shows "Checking…" forever and the
// Client can retry. Runs every five minutes (crons.ts). Plain code, no AI.
//
// Reads only rows that can be stuck, through the by_status indexes. The first version collected
// whole tables every two minutes and alone used 1.5 GB of database I/O in a week on the free plan.
//
// - a web search older than 15 minutes fails, and the matches waiting on it rank what the catalog has
// - a match still reading or explaining after 10 minutes ends (keeping any robots it already ranked)
// - a match still waiting on a search after 20 minutes ends with a note
// - a job breakdown still splitting after 10 minutes fails
export const MATCH_STUCK_MS = 10 * 60 * 1000;
export const SEARCH_WAIT_STUCK_MS = 20 * 60 * 1000;
export const SPLIT_STUCK_MS = 10 * 60 * 1000;
const IN_PROGRESS_DISCOVERY = ["searching", "crawling", "extracting"] as const;
const IN_PROGRESS_MATCH = ["reading", "ranked", "searching"] as const;

export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let searches = 0, matches = 0, workflows = 0;

    for (const status of IN_PROGRESS_DISCOVERY) {
      const rows = await ctx.db.query("discoveries").withIndex("by_status", (q) => q.eq("status", status)).collect();
      for (const d of rows) {
        if (now - d._creationTime < STUCK_MS) continue;
        await finishDiscovery(ctx, d._id, { status: "failed", robotsFound: 0, error: "the search took too long and was stopped." });
        searches++;
      }
    }

    for (const status of IN_PROGRESS_MATCH) {
      const rows = await ctx.db.query("matches").withIndex("by_status", (q) => q.eq("status", status)).collect();
      for (const m of rows) {
        const age = now - m._creationTime;
        const stuck = status === "searching" ? age > SEARCH_WAIT_STUCK_MS : age > MATCH_STUCK_MS;
        if (!stuck) continue;
        await ctx.db.patch(m._id, status === "searching"
          ? { status: "done", searchNote: m.searchNote ?? "Web search failed: it took too long. Try again." }
          : { status: m.picks.length > 0 ? "done" : "failed", error: m.error ?? "This took too long. Try again." });
        matches++;
      }
    }

    const splitting = await ctx.db.query("workflows").withIndex("by_status", (q) => q.eq("status", "splitting")).collect();
    for (const w of splitting) {
      if (now - w._creationTime < SPLIT_STUCK_MS) continue;
      await ctx.db.patch(w._id, { status: "failed", error: "Breaking the job down took too long." });
      workflows++;
    }
    return { searches, matches, workflows };
  },
});

import { internalMutation } from "./_generated/server";
import { finishDiscovery, STUCK_MS } from "./discovery";

// Ends work that crashed or ran out of time, so the page never shows "Checking…" forever and the
// Client can retry. Runs every two minutes (crons.ts). Plain code, no AI.
//
// - a web search older than 15 minutes fails, and the matches waiting on it rank what the catalog has
// - a match still reading or explaining after 10 minutes ends (keeping any robots it already ranked)
// - a match still waiting on a search after 20 minutes ends with a note
// - a job breakdown still splitting after 10 minutes fails
export const MATCH_STUCK_MS = 10 * 60 * 1000;
export const SEARCH_WAIT_STUCK_MS = 20 * 60 * 1000;
export const SPLIT_STUCK_MS = 10 * 60 * 1000;
const RECENT_ROWS = 300; // newest matches / workflows to look at; older ones were swept already

export const sweepStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let searches = 0, matches = 0, workflows = 0;

    for (const d of await ctx.db.query("discoveries").collect()) {
      if (d.status === "done" || d.status === "failed" || now - d._creationTime < STUCK_MS) continue;
      await finishDiscovery(ctx, d._id, { status: "failed", robotsFound: 0, error: "the search took too long and was stopped." });
      searches++;
    }

    for (const m of await ctx.db.query("matches").order("desc").take(RECENT_ROWS)) {
      const age = now - m._creationTime;
      const stuck = (m.status === "reading" || m.status === "ranked") ? age > MATCH_STUCK_MS
        : m.status === "searching" ? age > SEARCH_WAIT_STUCK_MS : false;
      if (!stuck) continue;
      await ctx.db.patch(m._id, m.status === "searching"
        ? { status: "done", searchNote: m.searchNote ?? "Web search failed: it took too long. Try again." }
        : { status: m.picks.length > 0 ? "done" : "failed", error: m.error ?? "This took too long. Try again." });
      matches++;
    }

    for (const w of await ctx.db.query("workflows").order("desc").take(RECENT_ROWS)) {
      if (w.status !== "splitting" || now - w._creationTime < SPLIT_STUCK_MS) continue;
      await ctx.db.patch(w._id, { status: "failed", error: "Breaking the job down took too long." });
      workflows++;
    }
    return { searches, matches, workflows };
  },
});

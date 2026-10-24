import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Clean up data created by the test scripts before a demo. Internal: run from
// the CLI only, never from a browser.
//
//   npx convex run maintenance:testData '{"action":"list"}'
//   npx convex run maintenance:testData '{"action":"delete","confirm":"delete-test-data"}'
//
// Only requests that match one of the markers below are touched, together with
// rows that belong to them. Everything else, including anything that merely looks
// like demo data, is reported as "unmatched" and left alone.

// Test scripts name every fictional company with this prefix.
export const TEST_COMPANY_PREFIX = "E2E-TEST ";
// Markers used by earlier versions of the test scripts.
const LEGACY_COMPANY_PREFIXES = [
  "Fictional E2E ",
  "E2E Fictional ",
  "Browser E2E Fictional Co",
  "Fictional Screenshot ",
  '<img src=x onerror="window.__xss=1">',
];
const LEGACY_TITLE_PREFIXES = ["[verify] "]; // first live check, saved without a profile

export const CONFIRM = "delete-test-data";

function isTestRequest(r: Doc<"operatorRequests">): boolean {
  const name = r.profile?.companyName;
  if (name !== undefined) {
    return [TEST_COMPANY_PREFIX, ...LEGACY_COMPANY_PREFIXES].some((p) => name.startsWith(p));
  }
  return LEGACY_TITLE_PREFIXES.some((p) => r.title.startsWith(p));
}

const label = (r: Doc<"operatorRequests">) => (r.profile?.companyName ?? r.title).slice(0, 60);

export const testData = internalMutation({
  args: {
    action: v.union(v.literal("list"), v.literal("delete")),
    confirm: v.optional(v.string()),
  },
  handler: async (ctx, { action, confirm }) => {
    if (action === "delete" && confirm !== CONFIRM) {
      throw new ConvexError(`To delete, pass "confirm": "${CONFIRM}". Run with "action": "list" first.`);
    }
    const requests = await ctx.db.query("operatorRequests").collect();
    const matched = requests.filter(isTestRequest);
    const unmatched = requests.filter((r) => !isTestRequest(r));

    // Rows that belong to a matched request.
    const related = { bounties: 0, requirementSpecs: 0, recommendations: 0, clarifications: 0, aiJobs: 0 };
    for (const r of matched) {
      for (const table of ["bounties", "requirementSpecs", "recommendations", "clarifications"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_request", (q) => q.eq("requestId", r._id))
          .collect();
        related[table] += rows.length;
        if (action === "delete") for (const row of rows) await ctx.db.delete(row._id);
      }
      const jobs = await ctx.db
        .query("aiJobs")
        .withIndex("by_request_kind", (q) => q.eq("requestId", r._id))
        .collect();
      related.aiJobs += jobs.length;
      if (action === "delete") for (const j of jobs) await ctx.db.delete(j._id);
      if (action === "delete") await ctx.db.delete(r._id);
    }

    return {
      action,
      deleted: action === "delete",
      matchedRequests: matched.length,
      relatedRows: related,
      matchedExamples: matched.slice(0, 5).map(label),
      unmatchedRequests: unmatched.length,
      unmatchedNames: unmatched.slice(0, 20).map(label), // never touched; review by hand
      markers: { companyPrefixes: [TEST_COMPANY_PREFIX, ...LEGACY_COMPANY_PREFIXES], titlePrefixes: LEGACY_TITLE_PREFIXES },
    };
  },
});

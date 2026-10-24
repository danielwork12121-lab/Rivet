import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";

// Made-up demo robots so you can build before the Apify import works.
// Prices are rough placeholders: replace them with real data.
const SAMPLE_ROBOTS = [
  { name: "Culvert crawler C2", vendor: "Demo Robotics", task: "inspection", price: 18000, yearlyOpex: 4000, automationShare: 0.7, environments: ["confined", "wet"], url: "https://example.com/c2" },
  { name: "Pipe scout mini", vendor: "Demo Robotics", task: "inspection", price: 9500, yearlyOpex: 2500, automationShare: 0.5, environments: ["confined"], url: "https://example.com/scout" },
  { name: "Commercial mower RM-60", vendor: "Demo Mowers", task: "mowing", price: 32000, yearlyOpex: 3000, automationShare: 0.6, environments: ["outdoor", "flat"], url: "https://example.com/rm60" },
  { name: "Slope mower SL-2", vendor: "Demo Mowers", task: "mowing", price: 45000, yearlyOpex: 5000, automationShare: 0.5, environments: ["outdoor", "slopes"], url: "https://example.com/sl2" },
  { name: "Yard spray rover", vendor: "Demo Ag", task: "spraying", price: 26000, yearlyOpex: 3500, automationShare: 0.55, environments: ["outdoor", "uneven"], url: "https://example.com/rover" },
];

// Run once: npx convex run robots:seed
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("robots").first();
    if (existing) return "Already seeded";
    for (const r of SAMPLE_ROBOTS) await ctx.db.insert("robots", { ...r, sample: true });
    return `Added ${SAMPLE_ROBOTS.length} robots`;
  },
});

// The manual-filter side of search (price slider, task).
export const search = query({
  args: { task: v.optional(v.string()), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { task, maxPrice }) => {
    const all = await ctx.db.query("robots").collect();
    return all.filter(
      (r) => (!task || r.task === task) && (maxPrice === undefined || r.price <= maxPrice),
    );
  },
});

// Same filter, for the AI's search_catalog tool.
export const searchInternal = internalQuery({
  args: { task: v.optional(v.string()), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { task, maxPrice }) => {
    const all = await ctx.db.query("robots").collect();
    return all
      .filter((r) => (!task || r.task === task) && (maxPrice === undefined || r.price <= maxPrice))
      .map((r) => ({ id: r._id, name: r.name, vendor: r.vendor, task: r.task, price: r.price, environments: r.environments }));
  },
});

export const get = query({
  args: { id: v.id("robots") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

// Look up a robot from an id the AI gave us. Returns null for unknown ids.
export const getByString = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const robotId = ctx.db.normalizeId("robots", id);
    return robotId ? await ctx.db.get(robotId) : null;
  },
});

export const insert = internalMutation({
  args: {
    name: v.string(), vendor: v.string(), task: v.string(), price: v.number(),
    yearlyOpex: v.number(), automationShare: v.number(), environments: v.array(v.string()), url: v.string(),
  },
  handler: async (ctx, robot) => ctx.db.insert("robots", { ...robot, sample: false }),
});
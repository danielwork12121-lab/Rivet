import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { robotSpec } from "./schema";

// Made-up demo robots so you can build before the Apify import works.
// Prices are rough placeholders: replace them with real data.
const SAMPLE_ROBOTS = [
  { name: "Culvert crawler C2", vendor: "Demo Robotics", task: "inspection", price: 18000, yearlyOpex: 4000, automationShare: 0.7, environments: ["confined", "wet"], url: "https://example.com/c2" },
  { name: "Pipe scout mini", vendor: "Demo Robotics", task: "inspection", price: 9500, yearlyOpex: 2500, automationShare: 0.5, environments: ["confined"], url: "https://example.com/scout" },
  { name: "Commercial mower RM-60", vendor: "Demo Mowers", task: "mowing", price: 32000, yearlyOpex: 3000, automationShare: 0.6, environments: ["outdoor", "flat"], url: "https://example.com/rm60" },
  { name: "Slope mower SL-2", vendor: "Demo Mowers", task: "mowing", price: 45000, yearlyOpex: 5000, automationShare: 0.5, environments: ["outdoor", "slopes"], url: "https://example.com/sl2" },
  { name: "Yard spray rover", vendor: "Demo Ag", task: "spraying", price: 26000, yearlyOpex: 3500, automationShare: 0.55, environments: ["outdoor", "uneven"], url: "https://example.com/rover" },
];

// The Robot Bounty page's sample products, mirrored here so Convex is the one
// canonical catalog (the page loads these and keeps its built-in copy only as an
// offline fallback). Every number is illustrative; none describes a real product.
const PAGE_SAMPLE_PROVENANCE =
  "Fictional sample product from the Robot Bounty prototype. Price, running cost, automation share, slope limit, regions and TRL are illustrative, not vendor data.";
const PAGE_TASK = { mow: "mowing", trim: "trimming", spray: "spraying", perim: "spraying", crawl: "inspection" } as const;
export const PAGE_SAMPLE_PRODUCTS = [
  { sampleKey: "p1", taskKey: "mow", name: "TurfRover R2", vendor: "Sample Robotics Co. A", price: 18500, yearlyOpex: 1200, automationShare: 0.7, slopeLimitDeg: 20, regions: ["West", "South"], trl: 9 },
  { sampleKey: "p2", taskKey: "mow", name: "Fieldline AutoMow Pro", vendor: "Sample Robotics Co. B", price: 32000, yearlyOpex: 2000, automationShare: 0.8, slopeLimitDeg: 30, regions: ["West", "South", "Midwest", "Northeast"], trl: 8 },
  { sampleKey: "p3", taskKey: "mow", name: "GreenPath Compact", vendor: "Sample Robotics Co. C", price: 6900, yearlyOpex: 600, automationShare: 0.4, slopeLimitDeg: 15, regions: ["West", "Midwest", "Northeast"], trl: 9 },
  { sampleKey: "p4", taskKey: "trim", name: "EdgeBot E1", vendor: "Sample Robotics Co. D", price: 14000, yearlyOpex: 1500, automationShare: 0.3, slopeLimitDeg: 10, regions: ["West", "South", "Midwest", "Northeast"], trl: 6 },
  { sampleKey: "p5", taskKey: "spray", name: "SprayScout S", vendor: "Sample Robotics Co. E", price: 21000, yearlyOpex: 1800, automationShare: 0.6, slopeLimitDeg: 15, regions: ["West", "South"], trl: 7 },
  { sampleKey: "p6", taskKey: "spray", name: "TankWalker T3", vendor: "Sample Robotics Co. F", price: 27500, yearlyOpex: 2400, automationShare: 0.65, slopeLimitDeg: 25, regions: ["West", "South", "Midwest"], trl: 7 },
  { sampleKey: "p7", taskKey: "perim", name: "PerimeterPro Rover", vendor: "Sample Robotics Co. G", price: 24000, yearlyOpex: 2200, automationShare: 0.5, slopeLimitDeg: 20, regions: ["West", "South", "Midwest", "Northeast"], trl: 7 },
  { sampleKey: "p8", taskKey: "crawl", name: "CrawlEye C2", vendor: "Sample Robotics Co. H", price: 9800, yearlyOpex: 700, automationShare: 0.7, slopeLimitDeg: 35, regions: ["West", "South", "Midwest", "Northeast"], trl: 8 },
  { sampleKey: "p9", taskKey: "crawl", name: "UnderView Mini", vendor: "Sample Robotics Co. I", price: 4200, yearlyOpex: 300, automationShare: 0.45, slopeLimitDeg: 25, regions: ["South", "Midwest"], trl: 9 },
] as const;

// Adds any sample robots that are missing; never changes or removes existing rows.
// Run: npx convex run robots:seed
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("robots").collect();
    const names = new Set(existing.map((r) => r.name));
    const keys = new Set(existing.map((r) => r.sampleKey).filter(Boolean));
    let added = 0;
    for (const r of SAMPLE_ROBOTS) {
      if (names.has(r.name)) continue;
      await ctx.db.insert("robots", { ...r, sample: true });
      added++;
    }
    for (const p of PAGE_SAMPLE_PRODUCTS) {
      if (keys.has(p.sampleKey)) continue;
      await ctx.db.insert("robots", {
        ...p,
        regions: [...p.regions],
        task: PAGE_TASK[p.taskKey],
        environments: [], // not stated for these samples; left empty rather than guessed
        url: "",
        sample: true,
        provenance: PAGE_SAMPLE_PROVENANCE,
      });
      added++;
    }
    return `Added ${added} robots (${existing.length} already present)`;
  },
});

// The manual-filter side of search (price slider, task).
export const search = query({
  args: { task: v.optional(v.string()), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { task, maxPrice }) => {
    const all = await ctx.db.query("robots").collect();
    // Robots without a listed price are kept out of a price filter: their price is unknown.
    return all.filter(
      (r) => (!task || r.task === task) &&
        (maxPrice === undefined || (r.priceStatus !== "quote_only" && r.price <= maxPrice)),
    );
  },
});

// Same filter, for the AI's search_catalog tool.
export const searchInternal = internalQuery({
  args: { task: v.optional(v.string()), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { task, maxPrice }) => {
    const all = await ctx.db.query("robots").collect();
    return all
      .filter((r) => (!task || r.task === task) &&
        (maxPrice === undefined || (r.priceStatus !== "quote_only" && r.price <= maxPrice)))
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
// ---------- Robots found on the web ----------

// Every robot for one task, real and sample, for the decision layer.
export const forTask = internalQuery({
  args: { task: v.string() },
  handler: async (ctx, { task }) => ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", task)).collect(),
});

// Task names already in the catalog, so the AI reuses "mowing" instead of inventing "lawn mowing".
export const knownTasks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = new Set<string>();
    for (const r of await ctx.db.query("robots").collect()) tasks.add(r.task);
    for (const d of await ctx.db.query("discoveries").collect()) tasks.add(d.task);
    return [...tasks].sort();
  },
});

// Adds a robot found on a vendor page, or updates it if that page was seen before.
export const upsertScraped = internalMutation({
  args: {
    name: v.string(),
    vendor: v.string(),
    task: v.string(),
    url: v.string(),
    price: v.number(),
    priceStatus: v.union(v.literal("listed"), v.literal("quote_only")),
    yearlyOpex: v.number(),
    automationShare: v.number(),
    environments: v.array(v.string()),
    specs: v.array(robotSpec),
    assumptions: v.array(v.string()),
  },
  handler: async (ctx, robot) => {
    const row = { ...robot, sample: false, fetchedAt: Date.now(), provenance: `Read from ${robot.url}` };
    const old = await ctx.db.query("robots").withIndex("by_url", (q) => q.eq("url", robot.url)).first();
    if (old) {
      await ctx.db.patch(old._id, row);
      return old._id;
    }
    return await ctx.db.insert("robots", row);
  },
});

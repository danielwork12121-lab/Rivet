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

// Deletes every fictional demo robot, so only robots found on the web remain.
// Run: npx convex run --prod robots:removeSamples
export const removeSamples = internalMutation({
  args: {},
  handler: async (ctx) => {
    const samples = (await ctx.db.query("robots").collect()).filter((r) => r.sample);
    for (const r of samples) await ctx.db.delete(r._id);
    return `Removed ${samples.length} sample robots`;
  },
});

// ---------- Flagship steep-slope demo: three manually verified commercial products ----------
// Not scraped: read by hand from each manufacturer's own page and entered here with the exact
// quote and source URL for every spec, so the citations are as solid as anything upsertScraped
// would produce. `sample: false` (these are real products), `priceStatus`/`automationShare` follow
// the same conventions as the scraped path (lib/extract.ts), and automationShareEstimated is set
// wherever a figure is a conservative placeholder rather than something the manufacturer stated.
// Idempotent by url: run again any time to pick up a future manual correction; it is a no-op.
// Run: npx convex run robots:seedFlagshipDemo
const VERIFIED_ON = "2026-10-25"; // the date these pages were actually read

const FLAGSHIP_ROBOTS = [
  {
    name: "RC Mowers REAPER 52",
    vendor: "RC Mowers",
    task: "mowing",
    url: "https://www.rcmowersusa.com/mowers/reaper/",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor"],
    specs: [
      { name: "max_slope_deg", value: 50, quote: "Slope capability: 50°, any direction", sourceUrl: "https://www.rcmowersusa.com/mowers/reaper/" },
      { name: "coverage_sqft_per_hour", value: 108900, quote: "Mow rate: Up to 2.5 acres/hour", sourceUrl: "https://www.rcmowersusa.com/mowers/reaper/" },
      { name: "width_m", value: 1.32, quote: "Cutting width: 52 in", sourceUrl: "https://www.rcmowersusa.com/mowers/reaper/" },
      { name: "weight_kg", value: 860.47, quote: "Dry weight: 1,897 lbs", sourceUrl: "https://www.rcmowersusa.com/mowers/reaper/" },
      { name: "runtime_hours", value: 8, quote: "Runtime: Up to 8 hours", sourceUrl: "https://www.rcmowersusa.com/mowers/reaper/" },
    ],
    assumptions: [
      "Remote-operated, not autonomous: a trained operator still runs it from up to 1,000 ft away, so " +
        "this isn't the same labor story as a fully autonomous mower. automationShare is a conservative " +
        "placeholder, not a manufacturer-stated labor-saved percentage.",
      "The manufacturer's page gives no new-unit price (quote only); it cites about $40,000 as a starting " +
        "cost for used machines, which this catalog entry deliberately does not use as the new-unit price.",
    ],
    provenance:
      `Manually verified from the manufacturer's official specification page on ${VERIFIED_ON}. Commercial, ` +
      "remote-operated slope mower built for steep embankments, retention/detention ponds, ditches, heavy " +
      "brush and similar hazardous terrain; the manufacturer states it is not built for residential or " +
      "small-scale use.",
  },
  {
    name: "Husqvarna Automower 435X AWD NERA",
    vendor: "Husqvarna",
    task: "mowing",
    url: "https://www.husqvarna.com/us/robotic-lawn-mowers/automower-435x-awd/",
    price: 2999.99,
    priceStatus: "listed" as const,
    yearlyOpex: 240,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor"],
    specs: [
      { name: "max_slope_deg", value: 35, quote: "Max slope: 70% inside the installation area (about 35°)", sourceUrl: "https://www.husqvarna.com/us/robotic-lawn-mowers/automower-435x-awd/" },
      { name: "runtime_hours", value: 2.4, quote: "About 145 minutes of typical mow time per charge", sourceUrl: "https://www.husqvarna.com/us/robotic-lawn-mowers/automower-435x-awd/" },
    ],
    assumptions: [
      "Running cost estimated at 8% of price per year (no manufacturer-stated figure).",
      // Keeps the literal phrase "Assumed to replace" for the same reason lib/extract.ts does:
      // pages/index.html already greys out and caveats the ROI figures when it sees that phrase.
      "No manufacturer-stated labor-saved percentage. Assumed to replace a conservative 15% of the task's labor.",
      "Husqvarna's own page classifies this model under residential robotic lawn mowers, for maintained " +
        "lawns up to about 0.9 acre -- this catalog doesn't yet encode a hard maximum-area limit, so check " +
        "the job's actual area against that figure before trusting a high match score alone.",
      "The 'NERA' (wire-free) variant's exact slope and price figures weren't separately confirmed on the " +
        "page read for this entry; verify before quoting a NERA-specific number.",
    ],
    provenance:
      `Manually verified from Husqvarna's official US product page on ${VERIFIED_ON}. Not a substitute for ` +
      "a heavy-duty commercial brush-clearing machine: Husqvarna positions it for maintained residential " +
      "lawns, and sells a separate commercial robotic-mower line for larger properties.",
  },
  {
    name: "RC Mowers RECONX",
    vendor: "RC Mowers",
    task: "mowing",
    url: "https://www.rcmowersusa.com/",
    price: 0,
    priceStatus: "quote_only" as const, // deliberate: see provenance -- not yet purchasable at any price
    yearlyOpex: 0,
    automationShare: 0,
    automationShareEstimated: true,
    environments: ["outdoor"],
    specs: [
      { name: "coverage_sqft_per_hour", value: 196020, quote: "each mowing about 4 to 5 acres per hour", sourceUrl: "https://www.rcmowersusa.com/" },
      { name: "width_m", value: 1.52, quote: "Deck: 60\" or 72\"", sourceUrl: "https://www.rcmowersusa.com/" },
    ],
    assumptions: [
      "Manufacturer-announced only, with production targeted for spring 2027: priced here as quote-only " +
        "on purpose, so no payback or savings figure is ever computed against it for a job today.",
      "Announced starting price is $39,986 for the 60\" deck model (manufacturer's own figure, as of " +
        VERIFIED_ON + ") -- not reflected in the price field above, which stays quote-only until it ships.",
    ],
    provenance:
      `Manually verified from RC Mowers' official site on ${VERIFIED_ON}. Fully autonomous commercial mower, ` +
      "not yet in production (spring 2027 target) -- treat as an upcoming product, never as a currently " +
      "purchasable one or as a community-created Idea Robot. Best suited for large, flat-to-low-rolling " +
      "acreage on a recurring schedule; the manufacturer positions steep-slope and heavy-brush work to its " +
      "REAPER line instead.",
  },
];

export const seedFlagshipDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    let added = 0;
    for (const r of FLAGSHIP_ROBOTS) {
      const existing = await ctx.db.query("robots").withIndex("by_url", (q) => q.eq("url", r.url)).first();
      if (existing) continue;
      await ctx.db.insert("robots", { ...r, sample: false, fetchedAt: Date.now() });
      added++;
    }
    return `Added ${added} flagship robots (${FLAGSHIP_ROBOTS.length - added} already present)`;
  },
});

// One-time backfill for robots scraped before automationShareEstimated existed (robots.ts
// upsertScraped / lib/extract.ts). Those rows already carry an assumptions sentence recording that
// their automation share was guessed, not read off the vendor's page -- this reads that sentence
// back rather than re-guessing, so it never marks a robot estimated that genuinely had a
// vendor-stated labor-saved percentage. Safe to run more than once. Run: npx convex run
// robots:backfillAutomationShareEstimated
export const backfillAutomationShareEstimated = internalMutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    for (const r of await ctx.db.query("robots").collect()) {
      if (r.sample || r.automationShareEstimated !== undefined) continue;
      const guessed = (r.assumptions ?? []).some(
        (a) => /task's labor/i.test(a) && /assumed|no vendor-stated/i.test(a),
      );
      if (!guessed) continue;
      await ctx.db.patch(r._id, { automationShareEstimated: true });
      updated++;
    }
    return `Flagged ${updated} previously-scraped robots whose automation share was guessed, not vendor-stated`;
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
    automationShareEstimated: v.optional(v.boolean()),
    environments: v.array(v.string()),
    specs: v.array(robotSpec),
    assumptions: v.array(v.string()),
    imageUrl: v.optional(v.string()),
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

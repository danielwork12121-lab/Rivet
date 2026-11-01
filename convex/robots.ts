import { v } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import { robotSpec } from "./schema";
import { usSaleOfRobot } from "./lib/usSale";

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
// Idempotent by url: a second run patches rows to match this list (so a re-read page's new photo or
// figure lands), and is otherwise a no-op. Run: npx convex run --prod robots:seedFlagshipDemo
const VERIFIED_ON = "2026-10-25"; // the date these pages were actually read

// Origin facts for the US sale status (lib/usSale.ts), by robot name. Kept separate from
// FLAGSHIP_ROBOTS so backfillUsSaleFields can patch rows that were seeded before these existed.
// usContentShare is left out on purpose wherever no figure has been verified.
const FLAGSHIP_US_SALE: Record<string, {
  madeIn: string; mobile: boolean; connected: boolean; fccAuthorizedBefore: boolean; usContentShare?: number;
}> = {
  // RC Mowers, Wisconsin ("engineered and built in Green Bay, Wisconsin" on the REAPER page); shipping
  // before the July 2026 rule.
  "RC Mowers REAPER 52": { madeIn: "US", mobile: true, connected: true, fccAuthorizedBefore: true },
  // Sold in the US for years before the rule.
  "Husqvarna Automower 435X AWD NERA": { madeIn: "SE", mobile: true, connected: true, fccAuthorizedBefore: true },
  // RC Mowers, Germantown, Wisconsin; announced for 2027, so it must meet the rule as a new model.
  "RC Mowers RECONX": { madeIn: "US", mobile: true, connected: true, fccAuthorizedBefore: false },
};

const REAPER = "https://www.rcmowersusa.com/mowers/reaper/";
const HUSQVARNA_435X = "https://www.husqvarna.com/us/robotic-lawn-mowers/automower-435x-awd/";
// REAPER and Husqvarna were read again on this date: both pages now serve a product photo, the
// REAPER page was redesigned (new wording, a published labor-savings figure), so their quotes
// below are the current page's exact sentences.
const FLAGSHIP_REVERIFIED_ON = "2026-10-31";

const FLAGSHIP_ROBOTS = [
  {
    name: "RC Mowers REAPER 52",
    vendor: "RC Mowers",
    task: "mowing",
    // Heavy brush and tall weeds on steep ground are what the maker builds it for (quoted below).
    extraTasks: ["brush clearing"],
    url: REAPER,
    imageUrl: "https://www.rcmowersusa.com/wp-content/uploads/2026/10/reaper-inline-962x1024.jpg",
    verifiedOn: FLAGSHIP_REVERIFIED_ON,
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    // The manufacturer's own page: "92% labor savings reported" (see assumptions for the quote).
    automationShare: 0.92,
    automationShareEstimated: false,
    environments: ["outdoor"],
    specs: [
      { name: "max_slope_deg", value: 50, quote: "The same 50° slope and 1,000-ft remote on a narrower 52-inch platform.", sourceUrl: REAPER },
      { name: "coverage_sqft_per_hour", value: 108900, quote: "Mows up to 2.5 acres an hour, cuts 10-foot grass, heavy brush, and 2-inch trees, and treads even lighter at 2.3 psi.", sourceUrl: REAPER },
      { name: "width_m", value: 1.32, quote: "52\" cutting width", sourceUrl: REAPER },
      { name: "weight_kg", value: 860.47, quote: "1,897 lbs (fuel & fluids add up to 100 lbs)", sourceUrl: REAPER },
      { name: "runtime_hours", value: 8, quote: "Both run up to 8 hours on a 12-gallon tank.", sourceUrl: REAPER },
    ],
    assumptions: [
      "Remote-operated, not autonomous: one trained operator runs it from up to 1,000 ft away, off the " +
        "slope. Built for the work a string-trimmer crew does by hand on steep ground: the maker says it " +
        "\"cuts 10-foot grass, heavy brush, and 2-inch trees\".",
      "Labor share is the manufacturer's published figure, not a Rivet estimate: its page states \"92% labor " +
        "savings reported\", quoting a customer: \"After our first 1,000 hours, we had a 92% savings in " +
        "labor\". That is one customer's result, not a guarantee for this job.",
      "The manufacturer publishes no new-unit price (quote only), so no payback is computed for it.",
    ],
    provenance:
      `Manually verified from the manufacturer's official REAPER page on ${FLAGSHIP_REVERIFIED_ON}. Commercial, ` +
      "remote-operated slope mower for embankments, ditches, pond banks and heavy brush; the manufacturer " +
      "states it is \"Not built for residential or small-scale use.\" Photo: the page's own og:image.",
  },
  {
    name: "Husqvarna Automower 435X AWD NERA",
    vendor: "Husqvarna",
    task: "mowing",
    url: HUSQVARNA_435X,
    imageUrl:
      "https://www.husqvarna.com/-/images/aprimo/husqvarna/robotic-mowers/photos/studio/o/ok/ok-383431.jpg?v=57f05ae6d152aa71&format=opengraph-cover",
    verifiedOn: FLAGSHIP_REVERIFIED_ON,
    price: 2999.99,
    priceStatus: "listed" as const,
    yearlyOpex: 240,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor"],
    specs: [
      { name: "max_slope_deg", value: 35, quote: "can comfortably handle slopes up to 70% (35 degrees) inside the cutting area", sourceUrl: HUSQVARNA_435X },
      { name: "runtime_hours", value: 2.4, quote: "The 435X AWD provides a typical mow time of 145 minutes on a single charge.", sourceUrl: HUSQVARNA_435X },
    ],
    assumptions: [
      "Running cost estimated at 8% of price per year (no manufacturer-stated figure).",
      // Keeps the literal phrase "Assumed to replace" for the same reason lib/extract.ts does:
      // pages/index.html already greys out and caveats the ROI figures when it sees that phrase.
      "No manufacturer-stated labor-saved percentage. Assumed to replace a conservative 15% of the task's labor.",
      "Husqvarna's own page rates this model for \"medium-to-large sized lawns up to 0.9 acres\" of maintained " +
        "grass. It mows grass; it does not cut tall weeds or brush, so it is not a string-trimmer replacement " +
        "on overgrown ground. This catalog doesn't yet encode a maximum-area limit: check the job's area first.",
      "The 'NERA' (wire-free) variant's exact slope and price figures weren't separately confirmed on the " +
        "page read for this entry; verify before quoting a NERA-specific number.",
    ],
    provenance:
      `Manually verified from Husqvarna's official US product page on ${FLAGSHIP_REVERIFIED_ON} ("Price from ` +
      "$2,999.99\"). Not a substitute for a heavy-duty commercial brush-clearing machine: Husqvarna positions " +
      "it for maintained residential lawns. Photo: the page's own og:image.",
  },
  {
    name: "RC Mowers RECONX",
    vendor: "RC Mowers",
    task: "mowing",
    url: "https://www.rcmowersusa.com/",
    verifiedOn: VERIFIED_ON,
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

// Inserts each curated robot, or patches its row (found by url) to match the list, so a correction
// here lands on the next run. `verifiedOn` (the day its page was read) becomes fetchedAt.
async function upsertCurated(
  ctx: MutationCtx,
  list: readonly ({ name: string; url: string; verifiedOn: string } & Omit<WithoutSystemFields<Doc<"robots">>, "sample" | "fetchedAt">)[],
  extra: (name: string) => Partial<WithoutSystemFields<Doc<"robots">>> = () => ({}),
) {
  const added: string[] = [];
  const updated: string[] = [];
  for (const { verifiedOn, ...r } of list) {
    const row = { ...r, ...extra(r.name), sample: false, fetchedAt: Date.parse(`${verifiedOn}T12:00:00Z`) };
    const existing = await ctx.db.query("robots").withIndex("by_url", (q) => q.eq("url", r.url)).first();
    if (!existing) {
      await ctx.db.insert("robots", row);
      added.push(r.name);
      continue;
    }
    const differs = Object.entries(row).some(
      ([k, val]) => stableJson((existing as Record<string, unknown>)[k]) !== stableJson(val),
    );
    if (differs) {
      await ctx.db.patch(existing._id, row);
      updated.push(r.name);
    }
  }
  return { added, updated, unchanged: list.length - added.length - updated.length };
}

// JSON with object keys sorted, so a stored row (whose key order the database may change) compares
// equal to the same data written here.
function stableJson(x: unknown): string {
  return JSON.stringify(x, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val);
}

// Idempotent: adds missing flagship robots and patches drifted ones (e.g. a re-read page's new photo).
export const seedFlagshipDemo = internalMutation({
  args: {},
  handler: async (ctx) => upsertCurated(ctx, FLAGSHIP_ROBOTS, (name) => FLAGSHIP_US_SALE[name] ?? {}),
});

// ---------- Pond / wetland demo: real aquatic products ----------
// Same rules as the flagship robots above: read by hand from each manufacturer's own page on
// AQUATIC_VERIFIED_ON, every spec carries the exact sentence and URL it came from, and anything the
// page didn't state is either left out or marked as an estimate in `assumptions`. Photos are the
// manufacturer's own published product images (og:image or the product photo on the same page),
// referenced by URL, never copied. Prices: only Lake Groomer publishes a USD price; the WasteShark
// FAQ gives a euro base price, kept in the notes rather than converted, so it stays quote-only.
// Idempotent by url: a second run patches rows to match this list, so a correction here lands.
// Run: npx convex run --prod robots:seedAquaticDemo
const AQUATIC_VERIFIED_ON = "2026-10-31";
const WSPRO = "https://www.ranmarine.io/wastesharkpro/";
const WS = "https://www.ranmarine.io/wastesharkclassic/";
const HYDRONE = "https://www.seafloorsystems.com/hydrone";
const LAKE_GROOMER = "https://lakegroomer.net/product/lake-groomer/";
const WEEDROLLER = "https://weedroller.com/products/";
const ESTIMATED_SHARE =
  "No manufacturer-stated labor-saved percentage. Assumed to replace a conservative 15% of the task's labor.";

export const AQUATIC_ROBOTS = [
  {
    name: "RanMarine WasteShark+ Pro",
    vendor: "RanMarine Technology",
    task: "debris skimming",
    extraTasks: ["aquatic weed removal", "water survey"],
    url: WSPRO,
    imageUrl: "https://www.ranmarine.io/wp-content/uploads/WSPRO.webp",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    connected: true,
    specs: [
      { name: "payload_kg", value: 60, quote: "Basket Weight Capacity 60 kg 132 lbs", sourceUrl: WSPRO },
      { name: "weight_kg", value: 78, quote: "Weight 78 kg 172 lbs", sourceUrl: WSPRO },
      { name: "runtime_hours", value: 6, quote: "6-Hour Autonomous Runtime", sourceUrl: WSPRO },
    ],
    assumptions: [
      "Autonomous surface drone (GPS RTK waypoint routes, LiDAR collision avoidance): it skims floating " +
        "litter and loose biomass such as duckweed or cut weed into a 160-liter basket. It does not uproot " +
        "rooted, submerged weeds.",
      "The page lists both \"Operating Time per Charge 8 hours\" and a \"6-Hour Autonomous Runtime\"; the " +
        "lower, autonomous figure is used here.",
      "Depth and temperature logging is standard (\"automatically logging bathymetry and thermal profiles " +
        "during every mission\"); water-quality sensors are optional add-on modules.",
      "Price on request: the manufacturer publishes no price for this model. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from RanMarine's official WasteShark+ Pro page on ${AQUATIC_VERIFIED_ON}. Daily ` +
      "figures stated there: \"Daily Coverage Capability 5,000 m² 1.2 acres\" and \"Waste Collection " +
      "Capacity/Day 500 kg\". Photo: the page's own og:image.",
  },
  {
    name: "RanMarine WasteShark",
    vendor: "RanMarine Technology",
    task: "debris skimming",
    extraTasks: ["aquatic weed removal"],
    url: WS,
    imageUrl: "https://www.ranmarine.io/wp-content/uploads/WasteShark-biomass-1.jpeg",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    connected: true,
    specs: [
      { name: "payload_kg", value: 60, quote: "Basket weight capacity 60 kg 132 lbs", sourceUrl: WS },
      { name: "weight_kg", value: 72, quote: "Weight 72 kg 159 lbs", sourceUrl: WS },
      { name: "runtime_hours", value: 5, quote: "Up to 5 hrs. of continuous operations before recharging", sourceUrl: WS },
    ],
    assumptions: [
      "Remote-operated, not autonomous: the manufacturer says it is \"100% pilot operated\" from shore, so a " +
        "person still drives it. It collects \"trash, weeds, or algae\" floating at the surface (up to 160 " +
        "liters a run); it does not uproot rooted weeds.",
      "The manufacturer's FAQ gives a base price of €23,500 (drone and remote controller; trolley, floating " +
        "basket and hook extra). Shown here as price on request rather than converted to dollars.",
      ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from RanMarine's official WasteShark page on ${AQUATIC_VERIFIED_ON}. Stated there: ` +
      "\"Trash collection capacity 500 kg/workday\", \"Coverage capability 10,000 m2 /workday\". Photo: the " +
      "page's own og:image (a WasteShark collecting duckweed and litter).",
  },
  {
    name: "Seafloor Systems HyDrone 4.5",
    vendor: "Seafloor Systems",
    task: "water survey",
    url: HYDRONE,
    imageUrl:
      "https://static.wixstatic.com/media/5e48e6_43cff92d6d7944bb8a673f7c67389f98%7Emv2.jpg/v1/fit/w_2500,h_1330,al_c/5e48e6_43cff92d6d7944bb8a673f7c67389f98%7Emv2.jpg",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    connected: true,
    specs: [
      { name: "runtime_hours", value: 9, quote: "Battery Endurance: Up to 9 hours at survey speed with 6S 22Ah batteries (field-swappable)", sourceUrl: HYDRONE },
      { name: "payload_kg", value: 15, quote: "Payload: 15 kg / 35 lbs", sourceUrl: HYDRONE },
      { name: "weight_kg", value: 9.8, quote: "Empty Hull Weight w/ Batteries: 9.8 kg / 25 lbs", sourceUrl: HYDRONE },
    ],
    assumptions: [
      "Unmanned survey catamaran for depth (bathymetry) and site surveys of ponds, lakes and rivers; " +
        "\"Both remotely controlled and autonomous navigation suites available\" (RCV, AutoNav, AutoNav Plus). " +
        "The echo sounder or sonar payload is configured per quote.",
      "Price on request: the manufacturer publishes no price. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Seafloor Systems' official HyDrone page on ${AQUATIC_VERIFIED_ON}. Use stated ` +
      "there: \"Inspection / survey of mines, sewage treatment plants, contaminated lakes, and rivers.\" " +
      "Photo: the page's own og:image (HyDrone survey boats on a lake).",
  },
  {
    name: "Lake Groomer",
    vendor: "Lake Groomer",
    task: "aquatic weed removal",
    url: LAKE_GROOMER,
    imageUrl: "https://lakegroomer.net/wp-content/uploads/2016/06/Lake-Groomer-2022.jpg",
    price: 4995,
    priceStatus: "listed" as const,
    yearlyOpex: 400,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    madeIn: "US",
    mobile: false,
    specs: [
      { name: "reach_m", value: 6.4, quote: "The standard model Lake Groomer comes with 21 feet of rollers (3 roller tubes each measuring 7 feet in length).", sourceUrl: LAKE_GROOMER },
    ],
    assumptions: [
      "Dock- or shore-mounted, automated roller that \"effortlessly uproots weeds\" along the bottom in a " +
        "circle around its mount (42 ft across as standard, up to 84 ft with extra rollers), in up to 4.5 ft " +
        "of water at the power head. One unit keeps one stretch of shoreline clear; it does not cover a " +
        "whole pond.",
      "Price is the low end of the listed range ($4,995.00 through $6,900.95).",
      "Running cost estimated at 8% of price per year (no manufacturer-stated figure).",
      ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Lake Groomer's official product page on ${AQUATIC_VERIFIED_ON} ("Price range: ` +
      "$4,995.00 through $6,900.95\"; \"made in the U.S.A\"). Photo: the page's own og:image.",
  },
  {
    name: "Crary WeedRoller PRO",
    vendor: "Crary WeedRoller",
    task: "aquatic weed removal",
    url: WEEDROLLER,
    imageUrl: "https://weedroller.com/wp-content/uploads/2024/09/WR_on-dock_1280x854_2017.png",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: false,
    specs: [
      { name: "reach_m", value: 6.4, quote: "The WeedRoller PRO can coperate in a 300 degree arc and is supplied with three 7′ rollers with a total length of 21′ from the drive head.", sourceUrl: WEEDROLLER },
    ],
    assumptions: [
      "Dock-mounted roller that \"works automatically when the waterfront is not in use\", rolling along the " +
        "bottom to uproot weeds and firm up muck; it reverses on its own in heavy weeds. Covers one arc of " +
        "shoreline per unit (up to 42 ft of rollers), not a whole pond. Local permits may limit the cleared area.",
      "Price on request here: the product page shows no price (sold through dealers). " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Crary WeedRoller's official products page on ${AQUATIC_VERIFIED_ON}. Photo: the ` +
      "product photo on the same page (WeedRoller PRO drive head on a dock).",
  },
];

export const seedAquaticDemo = internalMutation({
  args: {},
  handler: async (ctx) => upsertCurated(ctx, AQUATIC_ROBOTS.map((r) => ({ ...r, verifiedOn: AQUATIC_VERIFIED_ON }))),
});

// ---------- Weed/brush clearing and swamp/wetland demo: real products ----------
// Same rules as above, pages read by hand on FIELD_VERIFIED_ON. Two kinds of job the demo runs:
// - "brush clearing": tall weeds and brush on steep ground, the work a string-trimmer ("weed
//   whacker") crew does by hand. The REAPER 52 above also does it (its extraTasks).
// - swamp/marsh vegetation: amphibious machines that drive from land into a marsh or pond, cut
//   invasive vegetation and haul it out. They are crewed machines, not robots: each entry says so.
// Run: npx convex run --prod robots:seedBrushAndWetlandDemo (idempotent; patches drift)
const FIELD_VERIFIED_ON = "2026-10-31";
const MOWRATOR_50 =
  "https://mowrator.com/products/mowrator-s1-4wd-119-slope-remote-control-lawn-mower-with-leaf-shredding-vacuum";
const WEEDOO_6925 = "https://weedooboats.com/tc-6925-amphibious-vessels/";
const WEEDOO_6450 = "https://weedooboats.com/tc-6450-amphibious-vessels/";
const TRUXOR_T50 = "https://truxor.com/en/product/products-truxor-machines/truxor-t50--T50";
const AQUARIUS_HARVESTERS = "https://aquarius-systems.com/equipment/aquatic-weed-harvester/";
const CREWED =
  "Crewed machine, not a robot: an operator drives it on board. It replaces hand crews wading in with rakes " +
  "and trimmers, not the operator.";

export const BRUSH_AND_WETLAND_ROBOTS = [
  {
    name: "Mowrator S1 4WD (50° slope)",
    vendor: "Mowrator",
    task: "brush clearing",
    extraTasks: ["mowing"],
    url: MOWRATOR_50,
    imageUrl: "https://mowrator.com/cdn/shop/files/4WD-GP-18.webp?v=1792764238",
    price: 3739,
    priceStatus: "listed" as const,
    yearlyOpex: 299,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor"],
    mobile: true,
    specs: [
      { name: "max_slope_deg", value: 50, quote: "S1 4WD 119% Slope (50°)", sourceUrl: MOWRATOR_50 },
      { name: "coverage_sqft_per_hour", value: 21780, quote: "A 21-inch deck running at 3.4 mph covers 0.5 acres per hour.", sourceUrl: MOWRATOR_50 },
      { name: "runtime_hours", value: 2.25, quote: "56V LFP Battery, 2.25h Runtime, 1.125 Acres Per Charge", sourceUrl: MOWRATOR_50 },
      { name: "width_m", value: 0.53, quote: "A 21-inch deck running at 3.4 mph covers 0.5 acres per hour.", sourceUrl: MOWRATOR_50 },
    ],
    assumptions: [
      "Remote-controlled, not autonomous: one person drives it with a handheld remote from flat ground " +
        "instead of working the slope with a string trimmer. The maker lists 51-inch \"Max Tall Grass Cut\" " +
        "on slopes up to 50°; it is a 21-inch electric mower, not a flail mulcher for woody brush or saplings.",
      "Price is the 50° model's listed price on the maker's store (\"4WD 18Ah 50° Slope - $3,739.00\"; " +
        "regular price $4,399.00).",
      "Running cost estimated at 8% of price per year (no manufacturer-stated figure).",
      ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Mowrator's official product page on ${FIELD_VERIFIED_ON}. Photo: the page's own ` +
      "og:image (the S1 4WD with its remote).",
  },
  {
    name: "Weedoo TC-6925 Amphibious Weed Harvester",
    vendor: "Weedoo Greenboat",
    task: "aquatic weed removal",
    url: WEEDOO_6925,
    imageUrl: "https://weedooboats.com/wp-content/uploads/2023/12/Weedoo6925.jpg",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    specs: [
      { name: "width_m", value: 2.3, quote: "Cut Away—U-double-knife cutting system: mowing width 2.3m (7’-7”), mowing depth up to 1.5m (4’-11”)", sourceUrl: WEEDOO_6925 },
      { name: "payload_kg", value: 2750, quote: "5.5 m3 (7.2 yd.3)/2,750 kg (6,063 lb.)", sourceUrl: WEEDOO_6925 },
      { name: "weight_kg", value: 8900, quote: "Approx. 8,900 kg (19, 621 lb.)", sourceUrl: WEEDOO_6925 },
      { name: "coverage_sqft_per_hour", value: 123784.85, quote: "Estimated Production Rate 11,500 m2 (13,754 yd.)2/h", sourceUrl: WEEDOO_6925 },
    ],
    assumptions: [
      CREWED + " Cockpit-driven (\"Cockpit with clear and ergonomic controls\"); \"Autonomous loading and " +
        "unloading, drives itself into the water\" means it launches and lands itself on tracks, not that it " +
        "runs unmanned.",
      "Cuts rooted and floating vegetation down to 1.5 m, carries up to 2,750 kg of it on a conveyor deck and " +
        "drives up the bank on rubber tracks to unload, so cut weeds leave the water. The production rate is the " +
        "maker's own estimate.",
      "Price on request: Weedoo publishes no price for this model. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Weedoo Greenboat's official TC-6925 page on ${FIELD_VERIFIED_ON} (Weedoo Greenboat, ` +
      "Inc., Stuart, Florida). Photo: the page's own og:image.",
  },
  {
    name: "Weedoo AmphiKing 6450",
    vendor: "Weedoo Greenboat",
    task: "aquatic weed removal",
    extraTasks: ["debris skimming"],
    url: WEEDOO_6450,
    imageUrl: "https://weedooboats.com/wp-content/uploads/2023/12/tc-6450.jpg",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    specs: [
      { name: "reach_m", value: 2.4, quote: "7’10” (2.4 m) reach and 180o swing radius with quick-change system", sourceUrl: WEEDOO_6450 },
    ],
    assumptions: [
      CREWED + " The page lists \"Driver’s seat features armrests with pilot controls\".",
      "Built for swamps: \"Its powerful auger drives and compact size will ensure this model can easily navigate " +
        "even in the most demanding terrains, such as marshes, bogs, and swamps.\" Tracks for land, a boom with " +
        "cutting bar, weed grapple, collecting rake or dredge; the maker says it will \"remove all types of " +
        "weeds, debris, or unwanted vegetation\".",
      "Price on request: Weedoo publishes no price for this model. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Weedoo Greenboat's official AmphiKing 6450 page on ${FIELD_VERIFIED_ON}. Photo: the ` +
      "product photo on the same page.",
  },
  {
    name: "Truxor T50",
    vendor: "Truxor Wetland Equipment",
    task: "aquatic weed removal",
    url: TRUXOR_T50,
    imageUrl: "https://truxor.com/image/getthumbnail/1656?width=600&height=600&version=1&s=001",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    specs: [
      { name: "weight_kg", value: 1470, quote: "Total length max. 5030 mm, min 4700 mm. Total width 2080 mm. Total height max 2600, min 2020 mm. Set weight : 1470 kg", sourceUrl: TRUXOR_T50 },
      { name: "width_m", value: 2.08, quote: "Total length max. 5030 mm, min 4700 mm. Total width 2080 mm. Total height max 2600, min 2020 mm. Set weight : 1470 kg", sourceUrl: TRUXOR_T50 },
      { name: "payload_kg", value: 350, quote: "Lifting power 350 kg, X4 bracket for fast change of tools. Semi-automatic locking of tools.", sourceUrl: TRUXOR_T50 },
    ],
    assumptions: [
      CREWED + " Driven with two joysticks from the seat; \"remote assistance\" on the page is diagnostics for its " +
        "control units, not remote driving.",
      "Amphibious tool carrier on pontoons and paddle tracks for reed beds, marshes and shallow water. It cuts, " +
        "rakes and collects with attachments sold separately (cutter bar, rake, pumps); payload here is the " +
        "front lift's \"Lifting power 350 kg\".",
      "Price on request: Truxor sells through dealers and publishes no price. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Truxor Wetland Equipment's official T50 page on ${FIELD_VERIFIED_ON}. The same site's ` +
      "invasive-plants page (https://truxor.com/en/content/invasive-aquatic-plants) names the Truxor for " +
      "\"lakes, rivers, and wetlands\" overrun by invasive plants. Photo: " +
      "the product photo on the T50 page.",
  },
  {
    name: "Aquarius Systems HM-420 Aquatic Weed Harvester",
    vendor: "Aquarius Systems",
    task: "aquatic weed removal",
    url: AQUARIUS_HARVESTERS,
    imageUrl: "https://aquarius-systems.com/wp-content/uploads/2022/09/home-product-harvester-2-1.webp",
    price: 0,
    priceStatus: "quote_only" as const,
    yearlyOpex: 0,
    automationShare: 0.15,
    automationShareEstimated: true,
    environments: ["outdoor", "water"],
    mobile: true,
    specs: [
      { name: "width_m", value: 2.13, quote: "The ever popular 420 Series Weed Harvester has a minimum 7’ 0” (2,13 m) wide horizontal sickle bar and is the solution for medium sized harvesting projects.", sourceUrl: AQUARIUS_HARVESTERS },
    ],
    assumptions: [
      CREWED + " \"The Aquatic Weed Harvester has an operating console built for maximum comfort during long " +
        "workdays.\" It cuts submerged weeds with sickle bars and lifts them aboard on a conveyor; it works from " +
        "open water, not on land or in a reed marsh.",
      "Built to order: \"Many of our mechanical weed harvesters are customized to match the needs of your " +
        "lake.\" Price on request. " + ESTIMATED_SHARE,
    ],
    provenance:
      `Manually verified from Aquarius Systems' official aquatic weed harvester page on ${FIELD_VERIFIED_ON}. ` +
      "Photo: the harvester photo on the same page.",
  },
];

export const seedBrushAndWetlandDemo = internalMutation({
  args: {},
  handler: async (ctx) =>
    upsertCurated(ctx, BRUSH_AND_WETLAND_ROBOTS.map((r) => ({ ...r, verifiedOn: FIELD_VERIFIED_ON }))),
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

// Sets the US-sale origin fields on the flagship robots already in the table (seedFlagshipDemo only
// inserts missing rows). Matches by name; only writes fields that differ, so running it again is a
// no-op. Sample robots need nothing: sample alone makes their status "unknown".
// Run: npx convex run --prod robots:backfillUsSaleFields
export const backfillUsSaleFields = internalMutation({
  args: {},
  handler: async (ctx) => {
    const updated: string[] = [];
    for (const r of await ctx.db.query("robots").collect()) {
      const want = r.sample ? undefined : FLAGSHIP_US_SALE[r.name];
      if (!want) continue;
      const patch: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(want)) if ((r as Record<string, unknown>)[k] !== val) patch[k] = val;
      if (Object.keys(patch).length === 0) continue;
      await ctx.db.patch(r._id, patch);
      updated.push(r.name);
    }
    return { updated, unchanged: Object.keys(FLAGSHIP_US_SALE).filter((n) => !updated.includes(n)) };
  },
});

// The manual-filter side of search (price slider, task).
export const search = query({
  args: { task: v.optional(v.string()), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { task, maxPrice }) => {
    const all = await ctx.db.query("robots").collect();
    // Robots without a listed price are kept out of a price filter: their price is unknown.
    return all
      .filter(
        (r) => (!task || r.task === task) &&
          (maxPrice === undefined || (r.priceStatus !== "quote_only" && r.price <= maxPrice)),
      )
      .map((r) => ({ ...r, usSale: usSaleOfRobot(r) }));
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
      .map((r) => ({ id: r._id, name: r.name, vendor: r.vendor, task: r.task, price: r.price, environments: r.environments, usSale: usSaleOfRobot(r).status }));
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

// Every robot for one task, real and sample, for the decision layer: its main task, or one of its
// extraTasks (a skimmer that also logs depth). The catalog is small, so the extra-task check scans.
export const forTask = internalQuery({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const main = await ctx.db.query("robots").withIndex("by_task", (q) => q.eq("task", task)).collect();
    const ids = new Set(main.map((r) => r._id));
    const extra = (await ctx.db.query("robots").collect()).filter((r) => !ids.has(r._id) && r.extraTasks?.includes(task));
    return [...main, ...extra];
  },
});

// Task names already in the catalog, so the AI reuses "mowing" instead of inventing "lawn mowing".
export const knownTasks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = new Set<string>();
    for (const r of await ctx.db.query("robots").collect()) {
      tasks.add(r.task);
      for (const t of r.extraTasks ?? []) tasks.add(t);
    }
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

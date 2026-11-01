/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { rankRobots, type Intent } from "./lib/decide";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("robots:seed", () => {
  it("adds both sample sets once, all marked sample with provenance for page products", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.robots.seed, {})).toBe("Added 14 robots (0 already present)");
    expect(await t.mutation(internal.robots.seed, {})).toBe("Added 0 robots (14 already present)");
    const all = await t.query(api.robots.search, {});
    expect(all).toHaveLength(14);
    expect(all.every((r) => r.sample)).toBe(true);
    const page = all.filter((r) => r.sampleKey);
    expect(page).toHaveLength(9);
    expect(page.every((r) => r.provenance?.includes("illustrative") && r.environments.length === 0 && r.url === "")).toBe(true);
    expect((await t.query(api.robots.search, { task: "inspection" })).map((r) => r.name).sort()).toEqual(
      ["Culvert crawler C2", "CrawlEye C2", "Pipe scout mini", "UnderView Mini"].sort(),
    );
  });

  it("never overwrites an existing robot", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seed, {});
    const [p1] = (await t.query(api.robots.search, {})).filter((r) => r.sampleKey === "p1");
    await t.run((ctx) => ctx.db.patch(p1._id, { price: 1 }));
    await t.mutation(internal.robots.seed, {});
    const again = (await t.query(api.robots.search, {})).filter((r) => r.sampleKey === "p1");
    expect(again).toHaveLength(1);
    expect(again[0].price).toBe(1);
  });
});

describe("robots:seedFlagshipDemo", () => {
  it("adds the three verified steep-slope products once, as real (non-sample) robots", async () => {
    const t = convexTest(schema, modules);
    expect((await t.mutation(internal.robots.seedFlagshipDemo, {})).added).toHaveLength(3);
    expect(await t.mutation(internal.robots.seedFlagshipDemo, {})).toEqual({ added: [], updated: [], unchanged: 3 });
    const all = await t.query(internal.robots.forTask, { task: "mowing" });
    const names = all.map((r) => r.name).sort();
    expect(names).toEqual(["Husqvarna Automower 435X AWD NERA", "RC Mowers REAPER 52", "RC Mowers RECONX"]);
    expect(all.every((r) => !r.sample)).toBe(true);
  });

  it("patches a flagship row seeded before its photo existed, so a re-read page's photo reaches production", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    await t.run(async (ctx) => {
      const r = (await ctx.db.query("robots").collect()).find((x) => x.name === "RC Mowers REAPER 52")!;
      await ctx.db.patch(r._id, { imageUrl: undefined, automationShare: 0.15, automationShareEstimated: true });
    });
    expect((await t.mutation(internal.robots.seedFlagshipDemo, {})).updated).toEqual(["RC Mowers REAPER 52"]);
    const rows = await t.run((ctx) => ctx.db.query("robots").collect());
    expect(rows).toHaveLength(3);
    for (const name of ["RC Mowers REAPER 52", "Husqvarna Automower 435X AWD NERA"]) {
      const r = rows.find((x) => x.name === name)!;
      expect(new URL(r.imageUrl!).hostname).toBe(new URL(r.url).hostname); // the maker's own site
    }
  });

  it("uses the REAPER's labor figure only because the maker's page states it, and says whose figure it is", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    const [reaper] = (await t.query(internal.robots.forTask, { task: "brush clearing" })).filter((r) => r.name.includes("REAPER"));
    expect(reaper.automationShare).toBe(0.92);
    expect(reaper.automationShareEstimated).toBe(false);
    expect(reaper.assumptions!.join(" ")).toContain("\"92% labor savings reported\"");
    expect(reaper.assumptions!.join(" ")).toMatch(/one customer's result/);
  });

  it("never claims the REAPER 52 (remote-operated, no new-unit price) is currently priced", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    const [reaper] = (await t.query(internal.robots.forTask, { task: "mowing" })).filter((r) => r.name.includes("REAPER"));
    expect(reaper.priceStatus).toBe("quote_only");
  });

  it("never lets RECONX look purchasable today: it's an announced, pre-production product", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    const [reconx] = (await t.query(internal.robots.forTask, { task: "mowing" })).filter((r) => r.name.includes("RECONX"));
    expect(reconx.priceStatus).toBe("quote_only");
    expect(reconx.provenance).toContain("not yet in production");
  });

  it("flags the Husqvarna residential mower's slope requirement with a real manufacturer source", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    const [husq] = (await t.query(internal.robots.forTask, { task: "mowing" })).filter((r) => r.name.includes("Husqvarna"));
    expect(husq.specs?.find((s) => s.name === "max_slope_deg")).toMatchObject({ value: 35, sourceUrl: husq.url });
  });
});

describe("robots:seedAquaticDemo", () => {
  it("adds the real pond/wetland products once, each with a quoted vendor source and a vendor photo", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.robots.seedAquaticDemo, {});
    expect(first.added.length).toBe(5);
    expect(await t.mutation(internal.robots.seedAquaticDemo, {})).toEqual({ added: [], updated: [], unchanged: 5 });
    const rows = await t.run((ctx) => ctx.db.query("robots").collect());
    for (const r of rows) {
      expect(r.sample).toBe(false);
      expect(r.fetchedAt).toBeTypeOf("number");
      expect(r.imageUrl).toMatch(/^https:\/\//);
      expect(new URL(r.imageUrl!).hostname.replace(/^www\./, "")).toMatch(/ranmarine\.io|wixstatic\.com|lakegroomer\.net|weedroller\.com/);
      expect(r.specs!.length).toBeGreaterThan(0);
      for (const s of r.specs!) expect(s.sourceUrl).toBe(r.url);
      expect(r.provenance).toMatch(/Manually verified/);
    }
    // Only Lake Groomer publishes a dollar price; the rest stay quote-only rather than guessed.
    expect(rows.filter((r) => r.priceStatus === "listed").map((r) => r.name)).toEqual(["Lake Groomer"]);
  });

  it("patches a row that drifted from the verified data", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedAquaticDemo, {});
    await t.run(async (ctx) => {
      const r = (await ctx.db.query("robots").collect()).find((x) => x.name === "Lake Groomer")!;
      await ctx.db.patch(r._id, { price: 1 });
    });
    expect((await t.mutation(internal.robots.seedAquaticDemo, {})).updated).toEqual(["Lake Groomer"]);
  });

  it("finds a robot by any of its tasks, and lists those tasks for the AI", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedAquaticDemo, {});
    const names = async (task: string) => (await t.query(internal.robots.forTask, { task })).map((r) => r.name).sort();
    expect(await names("water survey")).toEqual(["RanMarine WasteShark+ Pro", "Seafloor Systems HyDrone 4.5"]);
    expect(await names("aquatic weed removal")).toEqual(
      ["Crary WeedRoller PRO", "Lake Groomer", "RanMarine WasteShark", "RanMarine WasteShark+ Pro"]);
    expect(await names("debris skimming")).toEqual(["RanMarine WasteShark", "RanMarine WasteShark+ Pro"]);
    expect(await t.query(internal.robots.knownTasks, {})).toEqual(
      expect.arrayContaining(["water survey", "aquatic weed removal", "debris skimming"]));
  });
});

describe("robots:seedBrushAndWetlandDemo", () => {
  it("adds the real brush-clearing and swamp products once, each with a quoted source and the maker's own photo", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.robots.seedBrushAndWetlandDemo, {});
    expect(first.added).toHaveLength(5);
    expect(await t.mutation(internal.robots.seedBrushAndWetlandDemo, {})).toEqual({ added: [], updated: [], unchanged: 5 });
    const rows = await t.run((ctx) => ctx.db.query("robots").collect());
    for (const r of rows) {
      expect(r.sample).toBe(false);
      expect(new URL(r.imageUrl!).hostname).toBe(new URL(r.url).hostname);
      expect(r.specs!.length).toBeGreaterThan(0);
      for (const s of r.specs!) expect(s.sourceUrl).toBe(r.url);
      expect(r.provenance).toMatch(/Manually verified/);
    }
    // Only Mowrator publishes a price; no harvester gets a guessed one.
    expect(rows.filter((r) => r.priceStatus === "listed").map((r) => r.name)).toEqual(["Mowrator S1 4WD (50° slope)"]);
    // Every amphibious harvester says plainly that a person drives it.
    for (const r of rows.filter((x) => x.task === "aquatic weed removal")) {
      expect(r.assumptions![0]).toMatch(/^Crewed machine, not a robot/);
    }
  });

  it("puts the brush cutters under brush clearing and the swamp machines under the water tasks", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    await t.mutation(internal.robots.seedAquaticDemo, {});
    await t.mutation(internal.robots.seedBrushAndWetlandDemo, {});
    const names = async (task: string) => (await t.query(internal.robots.forTask, { task })).map((r) => r.name).sort();
    expect(await names("brush clearing")).toEqual(["Mowrator S1 4WD (50° slope)", "RC Mowers REAPER 52"]);
    expect(await names("aquatic weed removal")).toEqual(expect.arrayContaining([
      "Weedoo TC-6925 Amphibious Weed Harvester", "Weedoo AmphiKing 6450", "Truxor T50",
      "Aquarius Systems HM-420 Aquatic Weed Harvester", "Lake Groomer",
    ]));
    expect(await names("debris skimming")).toContain("Weedoo AmphiKing 6450");
    // The residential Husqvarna is a lawn mower, never offered for weed and brush clearing.
    expect(await names("brush clearing")).not.toContain("Husqvarna Automower 435X AWD NERA");
  });

  // The scores the live demo shows, worked out by the real engine on the real catalog rows. Pinned so
  // a catalog edit that moves them is a visible change, not a surprise on stage.
  it("scores the demo's weed-clearing and wetland steps with the real engine", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    await t.mutation(internal.robots.seedAquaticDemo, {});
    await t.mutation(internal.robots.seedBrushAndWetlandDemo, {});
    const rank = async (intent: Intent) =>
      rankRobots(intent, (await t.query(internal.robots.forTask, { task: intent.task })).map((r) => ({ ...r, _id: r.name })))
        .map((p) => [p.robotId, p.score]);
    // "Cut tall weeds and brush": 65% of the operator's "58k a year".
    expect(await rank({ task: "brush clearing", annualTaskCost: 37700, budget: null, requirements: [] })).toEqual([
      ["Mowrator S1 4WD (50° slope)", 80], ["RC Mowers REAPER 52", 65],
    ]);
    // Same step with no yearly cost: every price-based cost score falls back to 0.5.
    expect(await rank({ task: "brush clearing", annualTaskCost: null, budget: null, requirements: [] })).toEqual([
      ["RC Mowers REAPER 52", 65], ["Mowrator S1 4WD (50° slope)", 65],
    ]);
    // "Pull invasive weeds" on the wetland pond, half of $60,000 a year.
    expect(await rank({ task: "aquatic weed removal", annualTaskCost: 30000, budget: null, requirements: [] })).toEqual([
      ["Lake Groomer", 75], ["Weedoo TC-6925 Amphibious Weed Harvester", 50], ["Truxor T50", 50],
    ]);
  });
});

describe("robots:backfillAutomationShareEstimated", () => {
  it("flags a previously-scraped robot whose automation share was guessed, from its own assumptions text", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.upsertScraped, {
      name: "Old scraped mower", vendor: "Vendor", task: "mowing", url: "https://vendor.example/old",
      price: 1800, priceStatus: "listed", yearlyOpex: 150, automationShare: 0.15, environments: ["outdoor"],
      specs: [], assumptions: ["No vendor-stated labor-saved figure; assumed a conservative 15% of the task's labor until a specific job is checked."],
    });
    expect(await t.mutation(internal.robots.backfillAutomationShareEstimated, {})).toBe(
      "Flagged 1 previously-scraped robots whose automation share was guessed, not vendor-stated",
    );
    const [robot] = await t.query(internal.robots.forTask, { task: "mowing" });
    expect(robot.automationShareEstimated).toBe(true);
  });

  it("never flags a robot whose labor-saved percentage actually came from the vendor's page", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.upsertScraped, {
      name: "Verified mower", vendor: "Vendor", task: "mowing", url: "https://vendor.example/verified",
      price: 20000, priceStatus: "listed", yearlyOpex: 2000, automationShare: 0.6, environments: ["outdoor"],
      specs: [], assumptions: [],
    });
    await t.mutation(internal.robots.backfillAutomationShareEstimated, {});
    const [robot] = await t.query(internal.robots.forTask, { task: "mowing" });
    expect(robot.automationShareEstimated).toBeUndefined();
  });

  it("is a no-op the second time it runs", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.upsertScraped, {
      name: "Old scraped mower", vendor: "Vendor", task: "mowing", url: "https://vendor.example/old",
      price: 1800, priceStatus: "listed", yearlyOpex: 150, automationShare: 0.15, environments: ["outdoor"],
      specs: [], assumptions: ["No vendor-stated labor-saved figure; assumed a conservative 15% of the task's labor until a specific job is checked."],
    });
    await t.mutation(internal.robots.backfillAutomationShareEstimated, {});
    expect(await t.mutation(internal.robots.backfillAutomationShareEstimated, {})).toBe(
      "Flagged 0 previously-scraped robots whose automation share was guessed, not vendor-stated",
    );
  });
});

describe("robots:backfillUsSaleFields", () => {
  it("patches flagship rows seeded without origin fields, once, and search reports their US sale status", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.robots.seedFlagshipDemo, {});
    await t.mutation(internal.robots.seed, {});
    // Simulate rows seeded before the fields existed.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("robots").collect()) {
        if (!r.sample) await ctx.db.patch(r._id, { madeIn: undefined, mobile: undefined, connected: undefined, fccAuthorizedBefore: undefined });
      }
    });
    const first = await t.mutation(internal.robots.backfillUsSaleFields, {});
    expect(first.updated.sort()).toEqual(["Husqvarna Automower 435X AWD NERA", "RC Mowers REAPER 52", "RC Mowers RECONX"]);
    expect((await t.mutation(internal.robots.backfillUsSaleFields, {})).updated).toEqual([]);
    const byName = new Map((await t.query(api.robots.search, {})).map((r) => [r.name, r]));
    expect(byName.get("RC Mowers REAPER 52")!.usSale.status).toBe("ok");
    expect(byName.get("Husqvarna Automower 435X AWD NERA")!.usSale.status).toBe("ok");
    expect(byName.get("RC Mowers RECONX")!.usSale).toMatchObject({ status: "review", note: "US-made; domestic-content share not yet verified" });
    expect(byName.get("TurfRover R2")!.usSale.status).toBe("unknown");
  });
});

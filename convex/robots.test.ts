/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
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
    expect(await t.mutation(internal.robots.seedFlagshipDemo, {})).toBe("Added 3 flagship robots (0 already present)");
    expect(await t.mutation(internal.robots.seedFlagshipDemo, {})).toBe("Added 0 flagship robots (3 already present)");
    const all = await t.query(internal.robots.forTask, { task: "mowing" });
    const names = all.map((r) => r.name).sort();
    expect(names).toEqual(["Husqvarna Automower 435X AWD NERA", "RC Mowers REAPER 52", "RC Mowers RECONX"]);
    expect(all.every((r) => !r.sample)).toBe(true);
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

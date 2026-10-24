/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const valid = {
  title: "  Inspect culvert interiors ",
  description: "Culverts under Route 9 need yearly inspection.",
  environment: "Confined, wet, no GPS, 0.8m diameter",
  constraints: ["Must be tethered", "  ", "Under 5 kg"],
  cost: { currency: "usd", currentAnnualCost: 40000, budget: 25000 },
};

describe("operator requests", () => {
  it("stores a valid request, normalising input, and retrieves it", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.requests.create, valid);

    const doc = await t.query(api.requests.get, { id });
    expect(doc).toMatchObject({
      title: "Inspect culvert interiors",
      constraints: ["Must be tethered", "Under 5 kg"],
      cost: { currency: "USD", budget: 25000 },
      status: "submitted",
    });

    const all = await t.query(api.requests.list, {});
    expect(all.map((r) => r._id)).toEqual([id]);
  });

  it("accepts a request without cost info", async () => {
    const t = convexTest(schema, modules);
    const { cost: _cost, ...noCost } = valid;
    await expect(t.mutation(api.requests.create, noCost)).resolves.toBeTruthy();
  });

  it("lists newest first and respects limit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.requests.create, { ...valid, title: "first" });
    await t.mutation(api.requests.create, { ...valid, title: "second" });
    const one = await t.query(api.requests.list, { limit: 1 });
    expect(one.map((r) => r.title)).toEqual(["second"]);
  });

  it.each([
    ["blank title", { title: "   " }, /title must not be empty/],
    ["blank description", { description: "" }, /description must not be empty/],
    ["blank environment", { environment: " " }, /environment must not be empty/],
    ["overlong title", { title: "x".repeat(121) }, /title must be at most/],
    [
      "too many constraints",
      { constraints: Array.from({ length: 21 }, (_, i) => `c${i}`) },
      /At most 20 constraints/,
    ],
    ["bad currency", { cost: { currency: "dollars" } }, /3-letter code/],
    ["negative budget", { cost: { currency: "USD", budget: -1 } }, /non-negative/],
    ["NaN cost", { cost: { currency: "USD", currentAnnualCost: NaN } }, /non-negative/],
  ])("rejects %s", async (_name, patch, message) => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.requests.create, { ...valid, ...patch }),
    ).rejects.toThrow(message);
    expect(await t.query(api.requests.list, {})).toHaveLength(0);
  });

  it("reports validation failures as a ConvexError with a readable data string", async () => {
    const t = convexTest(schema, modules);
    const err = await t
      .mutation(api.requests.create, { ...valid, title: " " })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.data).toBe("title must not be empty");
  });

  it("rejects wrong argument types", async () => {
    const t = convexTest(schema, modules);
    await expect(
      // @ts-expect-error deliberately invalid
      t.mutation(api.requests.create, { ...valid, constraints: "nope" }),
    ).rejects.toThrow();
  });

  it("get returns null for a deleted id", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.requests.create, valid);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.query(api.requests.get, { id })).toBeNull();
  });

  describe("profile and clientToken", () => {
    const profile = {
      companyName: "  Green Acres Lawn Co. ",
      businessType: "lawn",
      region: "West",
      crewCount: 3,
      peoplePerCrew: 2,
      hourlyLaborCost: 24,
      visibility: "shared" as const,
    };

    it("stores a valid profile (trimmed) and returns it on get", async () => {
      const t = convexTest(schema, modules);
      const id = await t.mutation(api.requests.create, { ...valid, profile });
      const doc = await t.query(api.requests.get, { id });
      expect(doc?.profile).toEqual({ ...profile, companyName: "Green Acres Lawn Co." });
    });

    it("accepts a profile without peoplePerCrew", async () => {
      const t = convexTest(schema, modules);
      const { peoplePerCrew: _p, ...noPer } = profile;
      const id = await t.mutation(api.requests.create, { ...valid, profile: noPer });
      expect((await t.query(api.requests.get, { id }))?.profile).not.toHaveProperty(
        "peoplePerCrew",
      );
    });

    it.each([
      ["blank company", { companyName: "  " }, /profile.companyName must not be empty/],
      ["overlong company", { companyName: "x".repeat(101) }, /profile.companyName must be at most/],
      ["blank region", { region: "" }, /profile.region must not be empty/],
      ["blank business type", { businessType: " " }, /profile.businessType must not be empty/],
      ["zero crews", { crewCount: 0 }, /profile.crewCount must be a whole number/],
      ["fractional crews", { crewCount: 2.5 }, /profile.crewCount must be a whole number/],
      ["huge crews", { crewCount: 10_001 }, /profile.crewCount must be a whole number/],
      ["zero people", { peoplePerCrew: 0 }, /profile.peoplePerCrew must be a whole number/],
      ["zero wage", { hourlyLaborCost: 0 }, /profile.hourlyLaborCost must be greater than 0/],
      ["negative wage", { hourlyLaborCost: -5 }, /profile.hourlyLaborCost must be greater than 0/],
      ["NaN wage", { hourlyLaborCost: NaN }, /profile.hourlyLaborCost must be greater than 0/],
      ["absurd wage", { hourlyLaborCost: 10_001 }, /profile.hourlyLaborCost must be greater than 0/],
    ])("rejects profile with %s and stores nothing", async (_n, patch, message) => {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(api.requests.create, { ...valid, profile: { ...profile, ...patch } }),
      ).rejects.toThrow(message);
      expect(await t.query(api.requests.list, {})).toHaveLength(0);
    });

    it("rejects an unknown visibility value", async () => {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(api.requests.create, {
          ...valid,
          // @ts-expect-error deliberately invalid
          profile: { ...profile, visibility: "public" },
        }),
      ).rejects.toThrow();
    });

    it("returns the existing id for a repeated clientToken and inserts once", async () => {
      const t = convexTest(schema, modules);
      const args = { ...valid, profile, clientToken: "tok-12345678" };
      const first = await t.mutation(api.requests.create, args);
      const second = await t.mutation(api.requests.create, args);
      expect(second).toBe(first);
      expect(await t.query(api.requests.list, {})).toHaveLength(1);
    });

    it("creates exactly one row when the same token is submitted concurrently", async () => {
      const t = convexTest(schema, modules);
      const args = { ...valid, clientToken: "tok-concurrent" };
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => t.mutation(api.requests.create, args)),
      );
      expect(new Set(ids).size).toBe(1);
      expect(await t.query(api.requests.list, {})).toHaveLength(1);
    });

    it("treats different tokens, and no token, as separate requests", async () => {
      const t = convexTest(schema, modules);
      const a = await t.mutation(api.requests.create, { ...valid, clientToken: "tok-aaaaaaaa" });
      const b = await t.mutation(api.requests.create, { ...valid, clientToken: "tok-bbbbbbbb" });
      const c = await t.mutation(api.requests.create, valid);
      const d = await t.mutation(api.requests.create, valid);
      expect(new Set([a, b, c, d]).size).toBe(4);
    });

    it.each([
      ["too short", "abc"],
      ["bad characters", "tok with spaces!"],
      ["too long", "x".repeat(101)],
    ])("rejects a clientToken that is %s", async (_n, clientToken) => {
      const t = convexTest(schema, modules);
      await expect(
        t.mutation(api.requests.create, { ...valid, clientToken }),
      ).rejects.toThrow(/clientToken must be/);
    });

    it("keeps markup in text as inert data (no stripping or execution)", async () => {
      const t = convexTest(schema, modules);
      const evil = '<img src=x onerror="alert(1)">';
      const id = await t.mutation(api.requests.create, {
        ...valid,
        description: evil,
        profile: { ...profile, companyName: evil },
      });
      const doc = await t.query(api.requests.get, { id });
      expect(doc?.description).toBe(evil);
      expect(doc?.profile?.companyName).toBe(evil);
    });
  });
});

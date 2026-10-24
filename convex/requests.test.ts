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
});

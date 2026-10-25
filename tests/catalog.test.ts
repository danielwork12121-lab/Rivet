// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { PAGE_SAMPLE_PRODUCTS } from "../convex/robots";

// @ts-expect-error plain JS, no types
beforeAll(async () => { await import("../js/rivet-api.js"); });
const api = () => (globalThis as any).RivetApi;

// What robots:seed stores for the page products, shaped like a Convex row.
const asRows = () =>
  PAGE_SAMPLE_PRODUCTS.map((p, i) => ({ ...p, regions: [...p.regions], _id: `robot${i}`, sample: true }));

describe("catalog", () => {
  it("Convex's fictional copy is still mapped whole and marked as sample data", () => {
    const fromConvex = api().robotsToProducts(asRows());
    expect(fromConvex).toHaveLength(PAGE_SAMPLE_PRODUCTS.length);
    expect(fromConvex.every((p: any) => p.sample === true)).toBe(true);
  });

  it("maps only page-mirrored robots, in p1..pN order, keeping the Convex id", () => {
    const rows = [
      ...asRows().reverse(),
      { _id: "x", name: "Culvert crawler C2", vendor: "Demo Robotics", task: "inspection", price: 1, yearlyOpex: 1, automationShare: 0.5, environments: [], url: "", sample: true },
    ];
    const out = api().robotsToProducts(rows);
    expect(out.map((p: any) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
    expect(out[0]).toMatchObject({ robotId: "robot0", sample: true, maker: "Sample Robotics Co. A" });
  });

  it("returns an empty list for nothing", () => {
    expect(api().robotsToProducts(undefined)).toEqual([]);
  });
});

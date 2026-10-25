// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PAGE_SAMPLE_PRODUCTS } from "../convex/robots";

// @ts-expect-error plain JS, no types
beforeAll(async () => { await import("../js/rivet-api.js"); });
const api = () => (globalThis as any).RivetApi;

// The page's built-in PRODUCTS array, read straight from the deployed page's HTML.
function pageProducts() {
  const html = readFileSync(new URL("../pages/robot-bounty-client-flow.html", import.meta.url), "utf8");
  const literal = html.match(/const PRODUCTS = (\[[\s\S]*?\n\]);/)?.[1];
  if (!literal) throw new Error("PRODUCTS not found in the page");
  return new Function(`return ${literal};`)();
}

// What robots:seed stores for the page products, shaped like a Convex row.
const asRows = () =>
  PAGE_SAMPLE_PRODUCTS.map((p, i) => ({ ...p, regions: [...p.regions], _id: `robot${i}`, sample: true }));

describe("catalog", () => {
  // The page used to carry the same fictional products as robots:seed. They were removed so
  // operators only ever see real robots; Convex keeps its fictional copy for demos and tests,
  // hidden unless SHOW_SAMPLE_ROBOTS=true (convex/matching.ts) and never ranked by the agent.
  it("the client-flow page lists no fictional products", () => {
    expect(pageProducts()).toEqual([]);
  });

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

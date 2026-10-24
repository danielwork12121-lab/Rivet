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

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const base = {
  description: "Fictional.",
  environment: "Lawn care operation, West region, 1 crew of 2 people.",
  constraints: [],
};
const profile = (companyName: string) => ({
  companyName, businessType: "lawn", region: "West", crewCount: 1, peoplePerCrew: 2,
  hourlyLaborCost: 24, visibility: "shared" as const,
});
const bounty = {
  taskKey: "mow", title: "Mower", specLines: ["x"], gaps: [], note: "", industry: "Lawn care",
  pledgePercent: 30, pledged: 1000, goal: 150000,
};

async function seed() {
  const t = convexTest(schema, modules);
  const make = async (name: string | null, title = "Request", token?: string) =>
    t.mutation(api.requests.create, {
      ...base, title, ...(name ? { profile: profile(name) } : {}), ...(token ? { clientToken: token } : {}),
    });
  const testId = await make("E2E-TEST Lawn abc123", "Request", "tok-test-0001");
  await t.mutation(api.bounties.post, { requestId: testId, clientToken: "tok-test-0001", ...bounty });
  await make("Fictional E2E Pest xyz");
  await make(null, "[verify] culvert");
  const keepId = await make("Green Acres Lawn Co.", "Request", "tok-keep-0001");
  await t.mutation(api.bounties.post, { requestId: keepId, clientToken: "tok-keep-0001", ...bounty });
  await make("Real-looking Co. E2E-TEST"); // marker not at the start: not test data
  return { t, keepId };
}

describe("maintenance:testData", () => {
  it("list reports matches and unmatched rows and deletes nothing", async () => {
    const { t } = await seed();
    const r = await t.mutation(internal.maintenance.testData, { action: "list" });
    expect(r.deleted).toBe(false);
    expect(r.matchedRequests).toBe(3);
    expect(r.relatedRows.bounties).toBe(1);
    expect(r.unmatchedNames.sort()).toEqual(["Green Acres Lawn Co.", "Real-looking Co. E2E-TEST"]);
    expect(await t.query(internal.requests.list, {})).toHaveLength(5);
  });

  it("delete without the exact confirmation does nothing", async () => {
    const { t } = await seed();
    for (const confirm of [undefined, "yes", "DELETE-TEST-DATA"]) {
      await expect(
        t.mutation(internal.maintenance.testData, { action: "delete", ...(confirm ? { confirm } : {}) }),
      ).rejects.toThrow(/To delete, pass/);
    }
    expect(await t.query(internal.requests.list, {})).toHaveLength(5);
  });

  it("delete removes only matched requests and their bounties", async () => {
    const { t, keepId } = await seed();
    const r = await t.mutation(internal.maintenance.testData, { action: "delete", confirm: "delete-test-data" });
    expect(r).toMatchObject({ deleted: true, matchedRequests: 3 });
    const left = await t.query(internal.requests.list, {});
    expect(left.map((x) => x.profile?.companyName).sort()).toEqual(["Green Acres Lawn Co.", "Real-looking Co. E2E-TEST"]);
    const board = await t.query(api.bounties.listPosted, {});
    expect(board).toHaveLength(1);
    const remaining = await t.run((ctx) => ctx.db.query("bounties").collect());
    expect(remaining.map((b) => b.requestId)).toEqual([keepId]);
  });
});

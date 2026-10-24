/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const token = "bounty-test-token-1";
const profile = {
  companyName: "Fictional Green Acres Co.",
  businessType: "lawn",
  region: "West",
  crewCount: 3,
  peoplePerCrew: 2,
  hourlyLaborCost: 24,
  visibility: "shared" as const,
};
const intake = {
  title: "Fictional Green Acres Co. — Lawn care automation request",
  description: "Fictional: we mow 120 lawns a week.",
  environment: "Lawn care operation, West region, 3 crews of 2 people.",
  constraints: [],
  profile,
};
const bounty = {
  taskKey: "mow",
  title: "Autonomous mower for 28° slopes",
  specLines: ["Works on slopes up to 28°", "Note with <b>markup</b> & ampersand"],
  gaps: ["Can't handle slopes"],
  note: "Note with <b>markup</b> & ampersand",
  industry: "Lawn care",
  pledgePercent: 30,
  pledged: 4500,
  goal: 150000,
};

async function setup(visibility: "shared" | "anonymous" = "shared") {
  const t = convexTest(schema, modules);
  const requestId = await t.mutation(api.requests.create, {
    ...intake,
    profile: { ...profile, visibility },
    clientToken: token,
  });
  const all = () => t.run((ctx) => ctx.db.query("bounties").collect());
  return { t, requestId, all };
}

describe("bounties:post", () => {
  it("stores a posted client bounty with raw text and the request's region", async () => {
    const { t, requestId, all } = await setup();
    const id = await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    const [row] = await all();
    expect(row._id).toBe(id);
    expect(row).toMatchObject({
      requestId, status: "posted", source: "client", region: "West",
      note: "Note with <b>markup</b> & ampersand", specLines: bounty.specLines, pledged: 4500, goal: 150000,
    });
    expect(typeof row.updatedAt).toBe("number");
  });

  it("rejects a wrong token and stores nothing", async () => {
    const { t, requestId, all } = await setup();
    await expect(
      t.mutation(api.bounties.post, { requestId, clientToken: "someone-else", ...bounty }),
    ).rejects.toThrow(/Draft not found/);
    expect(await all()).toHaveLength(0);
  });

  it("rejects anonymous requests", async () => {
    const { t, requestId, all } = await setup("anonymous");
    await expect(
      t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty }),
    ).rejects.toThrow(/Anonymous requests can't post/);
    expect(await all()).toHaveLength(0);
  });

  it("posting the same task again updates the same bounty", async () => {
    const { t, requestId, all } = await setup();
    const a = await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    const b = await t.mutation(api.bounties.post, {
      requestId, clientToken: token, ...bounty, pledgePercent: 40, pledged: 6000, note: "",
    });
    expect(b).toBe(a);
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0].pledged).toBe(6000);
    expect(rows[0]).not.toHaveProperty("note");
  });

  it("concurrent posts for one task create exactly one bounty", async () => {
    const { t, requestId, all } = await setup();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty })),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await all()).toHaveLength(1);
  });

  it("a different task is a separate bounty", async () => {
    const { t, requestId, all } = await setup();
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty, taskKey: "spray" });
    expect(await all()).toHaveLength(2);
  });

  it.each([
    ["bad taskKey", { taskKey: "mow lawns" }, /taskKey must start with a letter/],
    ["blank title", { title: " " }, /title must not be empty/],
    ["blank spec line", { specLines: ["ok", "  "] }, /specLines item must not be empty/],
    ["too many spec lines", { specLines: Array.from({ length: 13 }, (_, i) => `l${i}`) }, /At most 12 spec lines/],
    ["too many gaps", { gaps: Array.from({ length: 11 }, (_, i) => `g${i}`) }, /At most 10 gaps/],
    ["overlong note", { note: "x".repeat(501) }, /note must be at most 500/],
    ["percent over 100", { pledgePercent: 101 }, /pledgePercent must be between 0 and 100/],
    ["negative pledge", { pledged: -1 }, /pledged must be a non-negative number/],
    ["NaN pledge", { pledged: NaN }, /pledged must be a non-negative number/],
    ["zero goal", { goal: 0 }, /goal must be greater than 0/],
    ["blank industry", { industry: "" }, /industry must not be empty/],
  ])("rejects %s and stores nothing", async (_n, patch, message) => {
    const { t, requestId, all } = await setup();
    await expect(
      t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty, ...patch }),
    ).rejects.toThrow(message);
    expect(await all()).toHaveLength(0);
  });
});

describe("bounties:getMine", () => {
  it("returns the owner's posted bounties, newest first, and rejects a wrong token", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty, taskKey: "spray" });
    const mine = await t.query(api.bounties.getMine, { requestId, clientToken: token });
    expect(mine.map((b) => b.taskKey)).toEqual(["spray", "mow"]);
    await expect(t.query(api.bounties.getMine, { requestId, clientToken: "nope-nope" })).rejects.toThrow(
      /Draft not found/,
    );
  });
});

describe("bounties:listPosted (public)", () => {
  it("exposes no requestId, company identity, token, gaps or note", async () => {
    const { t, requestId } = await setup();
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    const [pub] = await t.query(api.bounties.listPosted, {});
    expect(Object.keys(pub).sort()).toEqual(
      ["_creationTime", "_id", "goal", "industry", "pledged", "region", "specLines", "taskKey", "title"].sort(),
    );
    const text = JSON.stringify(pub);
    expect(text).not.toContain(requestId);
    expect(text).not.toContain("Fictional Green Acres Co.");
    expect(text).not.toContain(token);
  });

  it("never lists AI drafts, and agent:latestBounty returns only the AI draft", async () => {
    const { t, requestId } = await setup();
    await t.mutation(internal.agent.saveBounty, {
      requestId, title: "AI brief", summary: "s", mustHaves: ["m"], niceToHaves: [], acceptanceTest: "a", goal: 7200,
    });
    await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty });
    const pub = await t.query(api.bounties.listPosted, {});
    expect(pub.map((b) => b.title)).toEqual([bounty.title]);
    const draft = await t.query(api.agent.latestBounty, { requestId, clientToken: token });
    expect(draft).toMatchObject({ title: "AI brief", status: "draft", source: "ai" });
    const mine = await t.query(api.bounties.getMine, { requestId, clientToken: token });
    expect(mine.map((b) => b.title)).toEqual([bounty.title]);
  });

  it("lists newest first and caps the limit", async () => {
    const { t, requestId } = await setup();
    for (const taskKey of ["mow", "spray", "trim"]) {
      await t.mutation(api.bounties.post, { requestId, clientToken: token, ...bounty, taskKey });
    }
    expect((await t.query(api.bounties.listPosted, { limit: 2 })).map((b) => b.taskKey)).toEqual(["trim", "spray"]);
    expect(await t.query(api.bounties.listPosted, { limit: 0 })).toHaveLength(1);
  });
});

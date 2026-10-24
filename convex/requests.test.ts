/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper, signedIn } from "../tests/auth-helpers";

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
    const t = await asClient(convexTest(schema, modules));
    const id = await t.mutation(api.requests.create, valid);

    const doc = await t.query(internal.requests.get, { id });
    expect(doc).toMatchObject({
      title: "Inspect culvert interiors",
      constraints: ["Must be tethered", "Under 5 kg"],
      cost: { currency: "USD", budget: 25000 },
      status: "submitted",
    });

    const all = await t.query(internal.requests.list, {});
    expect(all.map((r) => r._id)).toEqual([id]);
  });

  it("accepts a request without cost info", async () => {
    const t = await asClient(convexTest(schema, modules));
    const { cost: _cost, ...noCost } = valid;
    await expect(t.mutation(api.requests.create, noCost)).resolves.toBeTruthy();
  });

  it("lists newest first and respects limit", async () => {
    const t = await asClient(convexTest(schema, modules));
    await t.mutation(api.requests.create, { ...valid, title: "first" });
    await t.mutation(api.requests.create, { ...valid, title: "second" });
    const one = await t.query(internal.requests.list, { limit: 1 });
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
    const t = await asClient(convexTest(schema, modules));
    await expect(
      t.mutation(api.requests.create, { ...valid, ...patch }),
    ).rejects.toThrow(message);
    expect(await t.query(internal.requests.list, {})).toHaveLength(0);
  });

  it("reports validation failures as a ConvexError with a readable data string", async () => {
    const t = await asClient(convexTest(schema, modules));
    const err = await t
      .mutation(api.requests.create, { ...valid, title: " " })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.data).toBe("title must not be empty");
  });

  it("rejects wrong argument types", async () => {
    const t = await asClient(convexTest(schema, modules));
    await expect(
      // @ts-expect-error deliberately invalid
      t.mutation(api.requests.create, { ...valid, constraints: "nope" }),
    ).rejects.toThrow();
  });

  it("get returns null for a deleted id", async () => {
    const t = await asClient(convexTest(schema, modules));
    const id = await t.mutation(api.requests.create, valid);
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.query(internal.requests.get, { id })).toBeNull();
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
      const t = await asClient(convexTest(schema, modules));
      const id = await t.mutation(api.requests.create, { ...valid, profile });
      const doc = await t.query(internal.requests.get, { id });
      expect(doc?.profile).toEqual({ ...profile, companyName: "Green Acres Lawn Co." });
    });

    it("accepts a profile without peoplePerCrew", async () => {
      const t = await asClient(convexTest(schema, modules));
      const { peoplePerCrew: _p, ...noPer } = profile;
      const id = await t.mutation(api.requests.create, { ...valid, profile: noPer });
      expect((await t.query(internal.requests.get, { id }))?.profile).not.toHaveProperty(
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
      const t = await asClient(convexTest(schema, modules));
      await expect(
        t.mutation(api.requests.create, { ...valid, profile: { ...profile, ...patch } }),
      ).rejects.toThrow(message);
      expect(await t.query(internal.requests.list, {})).toHaveLength(0);
    });

    it("rejects an unknown visibility value", async () => {
      const t = await asClient(convexTest(schema, modules));
      await expect(
        t.mutation(api.requests.create, {
          ...valid,
          // @ts-expect-error deliberately invalid
          profile: { ...profile, visibility: "public" },
        }),
      ).rejects.toThrow();
    });

    it("returns the existing id for a repeated clientToken and inserts once", async () => {
      const t = await asClient(convexTest(schema, modules));
      const args = { ...valid, profile, clientToken: "tok-12345678" };
      const first = await t.mutation(api.requests.create, args);
      const second = await t.mutation(api.requests.create, args);
      expect(second).toBe(first);
      expect(await t.query(internal.requests.list, {})).toHaveLength(1);
    });

    it("creates exactly one row when the same token is submitted concurrently", async () => {
      const t = await asClient(convexTest(schema, modules));
      const args = { ...valid, clientToken: "tok-concurrent" };
      const ids = await Promise.all(
        Array.from({ length: 5 }, () => t.mutation(api.requests.create, args)),
      );
      expect(new Set(ids).size).toBe(1);
      expect(await t.query(internal.requests.list, {})).toHaveLength(1);
    });

    it("treats different tokens, and no token, as separate requests", async () => {
      const t = await asClient(convexTest(schema, modules));
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
      const t = await asClient(convexTest(schema, modules));
      await expect(
        t.mutation(api.requests.create, { ...valid, clientToken }),
      ).rejects.toThrow(/clientToken must be/);
    });

    it("keeps markup in text as inert data (no stripping or execution)", async () => {
      const t = await asClient(convexTest(schema, modules));
      const evil = '<img src=x onerror="alert(1)">';
      const id = await t.mutation(api.requests.create, {
        ...valid,
        description: evil,
        profile: { ...profile, companyName: evil },
      });
      const doc = await t.query(internal.requests.get, { id });
      expect(doc?.description).toBe(evil);
      expect(doc?.profile?.companyName).toBe(evil);
    });
  });

  describe("account-owned drafts", () => {
    const token = "draft-token-1234";
    const profile = {
      companyName: "Fictional Lawn Co.",
      businessType: "lawn",
      region: "West",
      crewCount: 3,
      peoplePerCrew: 2,
      hourlyLaborCost: 24,
      visibility: "anonymous" as const,
    };
    const { clientToken: _omit, ...intake } = { ...valid, profile, clientToken: "" };
    const answers = [
      {
        key: "slope",
        question: "How many of your properties have slopes steeper than about 20°?",
        answerLabel: "A lot of them",
        assumption: { value: 28, unit: "degrees" },
      },
      {
        key: "obstacles",
        question: "Are most sites wide open?",
        answerLabel: "Mixed",
        assumption: { value: 0.85 },
      },
    ];

    async function setup() {
      const base = convexTest(schema, modules);
      const t = await asClient(base);
      const id = await t.mutation(api.requests.create, { ...intake, clientToken: token });
      return { t, base, id };
    }

    it("getDraft returns the owner's draft without the token", async () => {
      const { t, id } = await setup();
      const draft = await t.query(api.requests.getDraft, { id });
      expect(draft._id).toBe(id);
      expect(draft.profile?.companyName).toBe("Fictional Lawn Co.");
      expect(draft).not.toHaveProperty("clientToken");
    });

    it("rejects another Client account for read, intake update and follow-ups alike", async () => {
      const { base, id } = await setup();
      const other = await asClient(base, "user_client_b");
      await expect(other.query(api.requests.getDraft, { id })).rejects.toThrow(/Draft not found/);
      await expect(
        other.mutation(api.requests.updateIntake, { id, ...intake, title: "Hijacked" }),
      ).rejects.toThrow(/Draft not found/);
      await expect(
        other.mutation(api.requests.saveFollowUps, { id, answers, complete: true }),
      ).rejects.toThrow(/Draft not found/);
      const doc = await base.query(internal.requests.get, { id });
      expect(doc?.title).toBe("Inspect culvert interiors");
      expect(doc?.followUps).toBeUndefined();
    });

    it("rejects signed-out callers, accounts without a role and Developers", async () => {
      const { base, id } = await setup();
      await expect(base.query(api.requests.getDraft, { id })).rejects.toThrow(/Please sign in/);
      await expect(base.mutation(api.requests.create, intake)).rejects.toThrow(/Please sign in/);
      await expect(signedIn(base, "user_new").query(api.requests.getDraft, { id })).rejects.toThrow(/Finish setting up/);
      const dev = await asDeveloper(base);
      await expect(dev.query(api.requests.getDraft, { id })).rejects.toThrow(/needs a Client account/);
      await expect(dev.mutation(api.requests.create, intake)).rejects.toThrow(/needs a Client account/);
      await expect(dev.query(api.requests.listMine, {})).rejects.toThrow(/needs a Client account/);
    });

    it("gives the same error for an unknown id as for someone else's draft", async () => {
      const { t, id } = await setup();
      await t.run((ctx) => ctx.db.delete(id));
      await expect(t.query(api.requests.getDraft, { id })).rejects.toThrow(/^.*Draft not found/);
    });

    it("sets the owner from the signed-in account, never from arguments", async () => {
      const { base, id } = await setup();
      const doc = await base.query(internal.requests.get, { id });
      const owner = await base.run((ctx) => ctx.db.get(doc!.ownerId!));
      expect(owner?.clerkUserId).toBe("user_client_a");
    });

    it("a repeated clientToken from another account is refused, not returned", async () => {
      const { base } = await setup();
      const other = await asClient(base, "user_client_b");
      await expect(other.mutation(api.requests.create, { ...intake, clientToken: token })).rejects.toThrow(/already in use/);
      expect(await base.query(internal.requests.list, {})).toHaveLength(1);
    });

    it("listMine returns only the caller's requests, newest first, without tokens or owner", async () => {
      const { t, base, id } = await setup();
      const other = await asClient(base, "user_client_b");
      await other.mutation(api.requests.create, { ...intake, title: "Someone else" });
      const second = await t.mutation(api.requests.create, { ...intake, title: "My second" });
      const mine = await t.query(api.requests.listMine, {});
      expect(mine.map((r) => r._id)).toEqual([second, id]);
      expect(mine[0]).not.toHaveProperty("clientToken");
      expect(mine[0]).not.toHaveProperty("ownerId");
    });

    it("getDraft never returns the owner id", async () => {
      const { t, id } = await setup();
      expect(await t.query(api.requests.getDraft, { id })).not.toHaveProperty("ownerId");
    });

    describe("claimLegacyDraft (drafts saved before accounts)", () => {
      // A row as the old token-only API left it: no owner.
      async function legacy() {
        const base = convexTest(schema, modules);
        const id = await base.run((ctx) =>
          ctx.db.insert("operatorRequests", { ...intake, clientToken: token, status: "submitted" }));
        const bountyId = await base.run((ctx) => ctx.db.insert("bounties", {
          requestId: id, status: "posted", source: "client", title: "Old bounty", taskKey: "mow", goal: 1, pledged: 0,
        }));
        return { base, id, bountyId };
      }

      it("is unreachable until claimed, then belongs to the claimer with its bounties", async () => {
        const { base, id, bountyId } = await legacy();
        const me = await asClient(base);
        await expect(me.query(api.requests.getDraft, { id })).rejects.toThrow(/Draft not found/);
        expect(await me.mutation(api.requests.claimLegacyDraft, { id, clientToken: token })).toBe(id);
        expect((await me.query(api.requests.getDraft, { id })).title).toBe(intake.title);
        const owner = (await base.query(internal.requests.get, { id }))!.ownerId;
        expect((await base.run((ctx) => ctx.db.get(bountyId)))?.ownerId).toBe(owner);
        // Claiming again is harmless for the owner.
        expect(await me.mutation(api.requests.claimLegacyDraft, { id, clientToken: token })).toBe(id);
      });

      it("needs the right token, works only once, and only for Clients", async () => {
        const { base, id } = await legacy();
        const me = await asClient(base);
        await expect(me.mutation(api.requests.claimLegacyDraft, { id, clientToken: "wrong-token-123" })).rejects.toThrow(/Draft not found/);
        const dev = await asDeveloper(base);
        await expect(dev.mutation(api.requests.claimLegacyDraft, { id, clientToken: token })).rejects.toThrow(/needs a Client account/);
        await me.mutation(api.requests.claimLegacyDraft, { id, clientToken: token });
        const other = await asClient(base, "user_client_b");
        await expect(other.mutation(api.requests.claimLegacyDraft, { id, clientToken: token })).rejects.toThrow(/Draft not found/);
      });
    });

    it("updateIntake edits the same record: one row, new values, updatedAt set", async () => {
      const { t, id } = await setup();
      const returned = await t.mutation(api.requests.updateIntake, {
        id,
        ...intake,
        description: "  Edited fictional description ",
        profile: { ...profile, crewCount: 5 },
      });
      expect(returned).toBe(id);
      const all = await t.query(internal.requests.list, {});
      expect(all).toHaveLength(1);
      expect(all[0].description).toBe("Edited fictional description");
      expect(all[0].profile?.crewCount).toBe(5);
      expect(all[0].clientToken).toBe(token);
      expect(all[0].status).toBe("submitted");
      expect(typeof all[0].updatedAt).toBe("number");
    });

    it("updateIntake removes cost/profile when they are omitted", async () => {
      const { t, id } = await setup();
      const { profile: _p, cost: _c, ...bare } = intake;
      await t.mutation(api.requests.updateIntake, { id, ...bare });
      const doc = await t.query(internal.requests.get, { id });
      expect(doc).not.toHaveProperty("profile");
      expect(doc).not.toHaveProperty("cost");
    });

    it("updateIntake validates like create and leaves the record unchanged on failure", async () => {
      const { t, id } = await setup();
      await expect(
        t.mutation(api.requests.updateIntake, { id, ...intake, description: "  " }),
      ).rejects.toThrow(/description must not be empty/);
      expect((await t.query(internal.requests.get, { id }))?.description).toBe(valid.description);
    });

    it("updateIntake keeps follow-up answers", async () => {
      const { t, id } = await setup();
      await t.mutation(api.requests.saveFollowUps, { id, answers, complete: false });
      await t.mutation(api.requests.updateIntake, { id, ...intake, title: "New title" });
      const draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps).toHaveLength(2);
      expect(draft.title).toBe("New title");
    });

    it("saves follow-up answers with raw label, key and assumption kept apart", async () => {
      const { t, id } = await setup();
      await t.mutation(api.requests.saveFollowUps, { id, answers, complete: false });
      const draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps).toEqual(answers);
      expect(draft.followUpsComplete).toBe(false);
      expect(draft.followUps?.[1]).not.toHaveProperty("assumption.unit");
    });

    it("repeated identical saves are idempotent; a new save replaces the set", async () => {
      const { t, id } = await setup();
      const args = { id, answers, complete: false };
      await t.mutation(api.requests.saveFollowUps, args);
      await t.mutation(api.requests.saveFollowUps, args);
      let draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps).toEqual(answers);
      const changed = [{ ...answers[0], answerLabel: "Very few", assumption: { value: 15, unit: "degrees" } }];
      await t.mutation(api.requests.saveFollowUps, { ...args, answers: changed, complete: true });
      draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps).toEqual(changed);
      expect(draft.followUpsComplete).toBe(true);
      expect(await t.query(internal.requests.list, {})).toHaveLength(1);
    });

    it("trims answer text", async () => {
      const { t, id } = await setup();
      await t.mutation(api.requests.saveFollowUps, {
        id, complete: false,
        answers: [{ key: "weeks", question: " Weeks? ", answerLabel: " About 32 ", assumption: { value: 32, unit: " weeks per year " } }],
      });
      const draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps?.[0]).toEqual({
        key: "weeks", question: "Weeks?", answerLabel: "About 32", assumption: { value: 32, unit: "weeks per year" },
      });
    });

    it.each([
      ["duplicate keys", [answers[0], answers[0]], /duplicate key/],
      ["blank key", [{ ...answers[0], key: "" }], /followUps.key must start with a letter/],
      ["key with spaces", [{ ...answers[0], key: "slope angle" }], /followUps.key must start with a letter/],
      ["blank answer label", [{ ...answers[0], answerLabel: "  " }], /followUps.answerLabel must not be empty/],
      ["blank question", [{ ...answers[0], question: "" }], /followUps.question must not be empty/],
      ["overlong label", [{ ...answers[0], answerLabel: "x".repeat(201) }], /followUps.answerLabel must be at most/],
      ["NaN assumption", [{ ...answers[0], assumption: { value: NaN } }], /assumption.value must be a finite number/],
      ["Infinity assumption", [{ ...answers[0], assumption: { value: Infinity } }], /assumption.value must be a finite number/],
      ["blank unit", [{ ...answers[0], assumption: { value: 1, unit: " " } }], /assumption.unit must not be empty/],
      [
        "too many answers",
        Array.from({ length: 11 }, (_, i) => ({ ...answers[0], key: `k${i}` })),
        /At most 10 follow-up answers/,
      ],
    ])("rejects follow-ups with %s and stores nothing", async (_n, bad, message) => {
      const { t, id } = await setup();
      await expect(
        t.mutation(api.requests.saveFollowUps, { id, answers: bad, complete: false }),
      ).rejects.toThrow(message);
      expect((await t.query(internal.requests.get, { id }))?.followUps).toBeUndefined();
    });

    it("rejects follow-ups with the wrong shape", async () => {
      const { t, id } = await setup();
      await expect(
        t.mutation(api.requests.saveFollowUps, {
          id, complete: false,
          // @ts-expect-error deliberately invalid
          answers: [{ key: "slope", answerLabel: "Some" }],
        }),
      ).rejects.toThrow();
    });

    it("an empty answer set clears saved answers", async () => {
      const { t, id } = await setup();
      await t.mutation(api.requests.saveFollowUps, { id, answers, complete: false });
      await t.mutation(api.requests.saveFollowUps, { id, answers: [], complete: false });
      const draft = await t.query(api.requests.getDraft, { id });
      expect(draft.followUps).toEqual([]);
    });
  });
});

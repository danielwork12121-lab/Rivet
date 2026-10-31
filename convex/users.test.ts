/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asClient, asDeveloper, identity, signedIn } from "../tests/auth-helpers";

const modules = import.meta.glob("./**/*.*s");
const users = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("users").collect());

describe("users:me and ensureAccount", () => {
  it("me reports signed-out, signed-in without an account, and the account", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.users.me, {})).toEqual({ signedIn: false, account: null });
    const as = signedIn(t, "user_1");
    expect(await as.query(api.users.me, {})).toEqual({ signedIn: true, account: null });
    await as.mutation(api.users.ensureAccount, {});
    expect((await as.query(api.users.me, {})).account).toMatchObject({ role: null, approvedDeveloper: false });
  });

  it("creates one row per verified identity, however often it is called", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity(identity("user_1", { email: "one@example.test" }));
    await Promise.all([as.mutation(api.users.ensureAccount, {}), as.mutation(api.users.ensureAccount, {})]);
    await as.mutation(api.users.ensureAccount, {});
    const rows = await users(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clerkUserId: "user_1", email: "one@example.test" });
  });

  // A Clerk account older than this backend (e.g. after moving to a new deployment) arrives
  // with a valid token and no row. The pages heal it (js/rivet-api.js): on NO_ACCOUNT they call
  // ensureAccount and, if no role is set, ask the person to choose one. Nothing is assumed.
  it("a Clerk account with no row here: refused as 'finish setting up', never 'sign in'; healed by ensureAccount + chooseRole", async () => {
    const t = convexTest(schema, modules);
    const as = signedIn(t, "user_old");
    const req = { title: "Mow", description: "Mow the lawn weekly.", environment: "Outdoor grounds", constraints: [] };
    await expect(as.mutation(api.requests.create, req)).rejects.toThrow(/Finish setting up your account first/);
    expect(await as.mutation(api.users.ensureAccount, {})).toMatchObject({ role: null });
    await expect(as.mutation(api.requests.create, req)).rejects.toThrow(/Finish setting up your account first/);
    await as.mutation(api.users.chooseRole, { role: "client" });
    await expect(as.mutation(api.requests.create, req)).resolves.toBeTruthy();
    expect(await users(t)).toHaveLength(1);
  });

  it("refuses signed-out callers", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.users.ensureAccount, {})).rejects.toThrow(/Please sign in/);
    await expect(t.mutation(api.users.chooseRole, { role: "client" })).rejects.toThrow(/Please sign in/);
    expect(await users(t)).toHaveLength(0);
  });
});

describe("users:chooseRole", () => {
  it("a Client is active at once; repeating the choice is harmless", async () => {
    const t = convexTest(schema, modules);
    const as = signedIn(t, "user_1");
    const a = await as.mutation(api.users.chooseRole, { role: "client", name: " Ana ", organization: "Green Acres" });
    expect(a).toMatchObject({ role: "client", developerStatus: null, name: "Ana", organization: "Green Acres" });
    await as.mutation(api.users.chooseRole, { role: "client" });
    expect(await users(t)).toHaveLength(1);
  });

  it("a Developer starts pending and has no Developer access", async () => {
    const t = convexTest(schema, modules);
    const as = signedIn(t, "user_dev");
    expect(await as.mutation(api.users.chooseRole, { role: "developer" }))
      .toMatchObject({ role: "developer", developerStatus: "pending", approvedDeveloper: false });
    await expect(as.query(api.bounties.listPosted, {})).rejects.toThrow(/needs an approved Developer/);
  });

  it("a role can't be switched from the browser, in either direction", async () => {
    const t = convexTest(schema, modules);
    const client = await asClient(t);
    await expect(client.mutation(api.users.chooseRole, { role: "developer" })).rejects.toThrow(/already set/);
    const dev = await asDeveloper(t, "user_dev", false);
    await expect(dev.mutation(api.users.chooseRole, { role: "client" })).rejects.toThrow(/already set/);
    expect((await client.query(api.users.me, {})).account?.role).toBe("client");
  });

  it("re-choosing developer never resets an approval or a revocation", async () => {
    const t = convexTest(schema, modules);
    const dev = await asDeveloper(t, "user_dev"); // approved
    expect(await dev.mutation(api.users.chooseRole, { role: "developer" })).toMatchObject({ developerStatus: "approved" });
    await t.mutation(internal.users.setDeveloperStatus, { clerkUserId: "user_dev", status: "revoked" });
    expect(await dev.mutation(api.users.chooseRole, { role: "developer" })).toMatchObject({ developerStatus: "revoked" });
  });

  it("validates name and organization length", async () => {
    const t = convexTest(schema, modules);
    await expect(
      signedIn(t, "user_1").mutation(api.users.chooseRole, { role: "client", name: "x".repeat(101) }),
    ).rejects.toThrow(/name must be at most 100/);
  });

  it("never trusts the email for access: a rivet.dev address is just a Client", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity(identity("user_1", { email: "admin@rivet.dev" }));
    await as.mutation(api.users.chooseRole, { role: "client" });
    await expect(as.query(api.bounties.listPosted, {})).rejects.toThrow(/needs an approved Developer/);
  });
});

describe("developer approval", () => {
  async function invite(t: ReturnType<typeof convexTest>, days?: number) {
    return (await t.action(internal.users.createDeveloperInvite, { note: "Fictional Bayline", ...(days ? { days } : {}) })).code;
  }

  it("an admin approves and revokes by Clerk user id", async () => {
    const t = convexTest(schema, modules);
    const dev = await asDeveloper(t, "user_dev", false);
    await t.mutation(internal.users.setDeveloperStatus, { clerkUserId: "user_dev", status: "approved" });
    await expect(dev.query(api.bounties.listPosted, {})).resolves.toEqual([]);
    await t.mutation(internal.users.setDeveloperStatus, { clerkUserId: "user_dev", status: "revoked" });
    await expect(dev.query(api.bounties.listPosted, {})).rejects.toThrow(/needs an approved Developer/);
  });

  it("an admin can't make a Client into a Developer through approval", async () => {
    const t = convexTest(schema, modules);
    await asClient(t, "user_c");
    await expect(
      t.mutation(internal.users.setDeveloperStatus, { clerkUserId: "user_c", status: "approved" }),
    ).rejects.toThrow(/not a Developer account/);
  });

  it("stores only a hash of each invite code", async () => {
    const t = convexTest(schema, modules);
    const code = await invite(t);
    expect(code).toMatch(/^rivet-dev-[A-Za-z0-9_-]{24}$/);
    const rows = await t.run((ctx) => ctx.db.query("developerInvites").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0].codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("an invite approves a pending developer once; a second use fails", async () => {
    const t = convexTest(schema, modules);
    const code = await invite(t);
    const a = await asDeveloper(t, "user_dev_a", false);
    expect(await a.mutation(api.users.redeemDeveloperInvite, { code })).toMatchObject({ approvedDeveloper: true });
    const b = await asDeveloper(t, "user_dev_b", false);
    await expect(b.mutation(api.users.redeemDeveloperInvite, { code })).rejects.toThrow(/isn't valid/);
    expect((await b.query(api.users.me, {})).account?.developerStatus).toBe("pending");
  });

  it("an invite can be given at sign-up; a bad one leaves no account type set", async () => {
    const t = convexTest(schema, modules);
    const code = await invite(t);
    const as = signedIn(t, "user_dev");
    await expect(as.mutation(api.users.chooseRole, { role: "developer", inviteCode: "rivet-dev-not-a-real-code-000" }))
      .rejects.toThrow(/isn't valid/);
    expect((await as.query(api.users.me, {})).account?.role ?? null).toBeNull();
    expect(await as.mutation(api.users.chooseRole, { role: "developer", inviteCode: code }))
      .toMatchObject({ developerStatus: "approved" });
  });

  it("Clients and revoked developers can't redeem; expired codes fail", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const code = await invite(t, 1);
      const client = await asClient(t);
      await expect(client.mutation(api.users.redeemDeveloperInvite, { code })).rejects.toThrow(/for Developer accounts/);
      const revoked = await asDeveloper(t, "user_dev_r");
      await t.mutation(internal.users.setDeveloperStatus, { clerkUserId: "user_dev_r", status: "revoked" });
      await expect(revoked.mutation(api.users.redeemDeveloperInvite, { code })).rejects.toThrow(/isn't valid/);
      vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const late = await asDeveloper(t, "user_dev_late", false);
      await expect(late.mutation(api.users.redeemDeveloperInvite, { code })).rejects.toThrow(/isn't valid/);
    } finally {
      vi.useRealTimers();
    }
  });
});

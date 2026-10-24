import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// js/rivet-auth.js against a fake Clerk object. This checks our own logic (which
// Clerk calls we make, in what order, and what the page is told). It does NOT
// prove the real Clerk API behaves this way: that needs a live Clerk instance.

const g = globalThis as any;
const auth = () => g.RivetAuth;
const jwt = (claims: object) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

function fakeClerk() {
  const listeners: Array<() => void> = [];
  const clerk: any = {
    user: null, session: null,
    load: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn((fn: () => void) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }),
    setActive: vi.fn(async ({ session }: { session: string }) => {
      clerk.session = { id: session, getToken: vi.fn() };
      clerk.user = { id: "user_1", firstName: "Ana", primaryEmailAddress: { emailAddress: "ana@example.test" } };
      listeners.forEach((l) => l());
    }),
    signOut: vi.fn(async () => { clerk.user = null; clerk.session = null; listeners.forEach((l) => l()); }),
    client: {
      signIn: {
        create: vi.fn(), prepareSecondFactor: vi.fn().mockResolvedValue({}), attemptSecondFactor: vi.fn(),
        attemptFirstFactor: vi.fn(), supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_1" }],
      },
      signUp: { create: vi.fn().mockResolvedValue({}), prepareEmailAddressVerification: vi.fn().mockResolvedValue({}), attemptEmailAddressVerification: vi.fn() },
    },
    _emit: () => listeners.forEach((l) => l()),
  };
  return clerk;
}

let clerk: any;
beforeAll(async () => {
  g.atob = g.atob ?? ((s: string) => Buffer.from(s, "base64").toString("binary"));
  // @ts-expect-error plain JS, no types
  await import("../js/rivet-auth.js");
});
beforeEach(() => { clerk = fakeClerk(); g.Clerk = clerk; });
// ready() caches the instance; reload the module per test so each gets a fresh fake.
beforeEach(async () => {
  vi.resetModules();
  // @ts-expect-error plain JS, no types
  await import("../js/rivet-auth.js?t=" + Math.random());
});

describe("configuration", () => {
  it("derives the Frontend API host from the publishable key", () => {
    expect(auth()._frontendApi("pk_test_cmVsZXZhbnQta2luZ2Zpc2gtODI3MS5jbGVyay5hY2NvdW50cy5kZXYk"))
      .toBe("relevant-kingfish-8271.clerk.accounts.dev");
    expect(auth()._frontendApi("sk_test_secret")).toBeNull();
    expect(auth()._frontendApi("")).toBeNull();
  });
});

describe("tokens for Convex", () => {
  it("is null when signed out", async () => {
    expect(await auth().getToken()).toBeNull();
  });

  it("uses the session token when it already has audience convex (Clerk's Convex integration)", async () => {
    const token = jwt({ aud: "convex", sub: "user_1" });
    clerk.session = { id: "s1", getToken: vi.fn().mockResolvedValue(token) };
    expect(await auth().getToken()).toBe(token);
    expect(clerk.session.getToken).toHaveBeenCalledTimes(1);
    expect(clerk.session.getToken).toHaveBeenCalledWith({ skipCache: false });
  });

  it("falls back to the 'convex' JWT template otherwise, and passes forceRefresh through", async () => {
    clerk.session = { id: "s1", getToken: vi.fn().mockResolvedValueOnce(jwt({ aud: "other" })).mockResolvedValueOnce("templated") };
    expect(await auth().getToken({ forceRefresh: true })).toBe("templated");
    expect(clerk.session.getToken).toHaveBeenLastCalledWith({ template: "convex", skipCache: true });
  });

  it("returns null instead of throwing if Clerk can't produce a token", async () => {
    clerk.session = { id: "s1", getToken: vi.fn().mockRejectedValue(new Error("offline")) };
    expect(await auth().getToken()).toBeNull();
  });
});

describe("sign in", () => {
  it("email + password completes and activates the session", async () => {
    clerk.client.signIn.create.mockResolvedValue({ status: "complete", createdSessionId: "sess_1" });
    expect(await auth().signIn(" ana@example.test ", "pw-12345678")).toEqual({ status: "complete" });
    expect(clerk.client.signIn.create).toHaveBeenCalledWith({ identifier: "ana@example.test", password: "pw-12345678" });
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_1" });
  });

  it.each([["needs_client_trust"], ["needs_second_factor"]])("%s sends an email code, then the code completes", async (status) => {
    clerk.client.signIn.create.mockResolvedValue({ status, supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_1" }] });
    expect(await auth().signIn("ana@example.test", "pw")).toEqual({ status: "needs_code" });
    expect(clerk.client.signIn.prepareSecondFactor).toHaveBeenCalledWith({ strategy: "email_code", emailAddressId: "idn_1" });
    expect(clerk.setActive).not.toHaveBeenCalled();
    clerk.client.signIn.attemptSecondFactor.mockResolvedValue({ status: "complete", createdSessionId: "sess_2" });
    expect(await auth().verifySignInCode(" 123456 ")).toEqual({ status: "complete" });
    expect(clerk.client.signIn.attemptSecondFactor).toHaveBeenCalledWith({ strategy: "email_code", code: "123456" });
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_2" });
  });

  it("a second factor we can't handle is a clear error, not a silent hang", async () => {
    clerk.client.signIn.create.mockResolvedValue({ status: "needs_second_factor", supportedSecondFactors: [{ strategy: "totp" }] });
    await expect(auth().signIn("a@example.test", "pw")).rejects.toThrow(/doesn't support/);
  });

  it("maps Clerk's errors to plain messages", async () => {
    clerk.client.signIn.create.mockRejectedValue({ errors: [{ code: "form_password_incorrect", longMessage: "Password is incorrect. Try again." }] });
    await expect(auth().signIn("a@example.test", "bad")).rejects.toThrow("That email and password don't match an account.");
    clerk.client.signIn.attemptSecondFactor.mockRejectedValue({ errors: [{ code: "form_code_incorrect" }] });
    await expect(auth().verifySignInCode("000000")).rejects.toThrow(/code isn't right/);
    clerk.client.signIn.create.mockRejectedValue({ errors: [{ code: "something_new", longMessage: "Clerk says why." }] });
    await expect(auth().signIn("a@example.test", "pw")).rejects.toThrow("Clerk says why.");
  });

  it("is a no-op when already signed in", async () => {
    clerk.user = { id: "user_1" }; clerk.session = { id: "s" };
    expect(await auth().signIn("a@example.test", "pw")).toEqual({ status: "complete" });
    expect(clerk.client.signIn.create).not.toHaveBeenCalled();
  });
});

describe("sign up and email verification", () => {
  it("creates the sign-up, sends a code, and the code signs in", async () => {
    expect(await auth().signUp({ name: "Ana  María López", email: " ana@example.test ", password: "pw-12345678" }))
      .toEqual({ status: "needs_code" });
    expect(clerk.client.signUp.create).toHaveBeenCalledWith({
      emailAddress: "ana@example.test", password: "pw-12345678", firstName: "Ana", lastName: "María López",
    });
    expect(clerk.client.signUp.prepareEmailAddressVerification).toHaveBeenCalledWith({ strategy: "email_code" });
    clerk.client.signUp.attemptEmailAddressVerification.mockResolvedValue({ status: "complete", createdSessionId: "sess_new" });
    expect(await auth().verifySignUp("424242")).toEqual({ status: "complete" });
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_new" });
  });

  it("retries without names when the instance doesn't collect them", async () => {
    clerk.client.signUp.create
      .mockRejectedValueOnce({ errors: [{ code: "form_param_unknown", meta: { paramName: "first_name" } }] })
      .mockResolvedValueOnce({});
    await auth().signUp({ name: "Ana", email: "a@example.test", password: "pw-12345678" });
    expect(clerk.client.signUp.create).toHaveBeenLastCalledWith({ emailAddress: "a@example.test", password: "pw-12345678" });
  });

  it("an incomplete sign-up after the code is an error, never a fake success", async () => {
    clerk.client.signUp.attemptEmailAddressVerification.mockResolvedValue({ status: "missing_requirements" });
    await expect(auth().verifySignUp("424242")).rejects.toThrow(/needs more details/);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
});

describe("account recovery", () => {
  it("sends a reset code, then code + new password signs in", async () => {
    clerk.client.signIn.create.mockResolvedValue({ status: "needs_first_factor" });
    expect(await auth().startPasswordReset(" ana@example.test ")).toEqual({ status: "needs_code" });
    expect(clerk.client.signIn.create).toHaveBeenCalledWith({ strategy: "reset_password_email_code", identifier: "ana@example.test" });
    clerk.client.signIn.attemptFirstFactor.mockResolvedValue({ status: "complete", createdSessionId: "sess_r" });
    expect(await auth().completePasswordReset("111111", "new-pw-123456")).toEqual({ status: "complete" });
    expect(clerk.client.signIn.attemptFirstFactor).toHaveBeenCalledWith({
      strategy: "reset_password_email_code", code: "111111", password: "new-pw-123456",
    });
  });
});

describe("session changes", () => {
  it("onChange reports sign-in and sign-out once each, ignoring unrelated Clerk events", async () => {
    const seen: any[] = [];
    auth().onChange((st: any) => seen.push(st.signedIn));
    await vi.waitFor(() => expect(seen).toEqual([false]));
    clerk._emit(); // nothing changed
    await clerk.setActive({ session: "sess_1" });
    await clerk.signOut(); // also how an expired or revoked session looks
    expect(seen).toEqual([false, true, false]);
  });
});

describe("rivet-api auth glue", () => {
  beforeAll(async () => {
    // @ts-expect-error plain JS, no types
    await import("../js/rivet-api.js");
  });

  it("gives Convex a token fetcher on sign-in and closes the socket on sign-out", async () => {
    const client = { setAuth: vi.fn(), close: vi.fn() };
    const ended = vi.fn();
    g.RivetApi._authenticate(client, ended);
    await vi.waitFor(() => expect(clerk.addListener).toHaveBeenCalled()); // starts signed out: nothing to do
    expect(client.setAuth).not.toHaveBeenCalled();
    await clerk.setActive({ session: "sess_1" });
    expect(client.setAuth).toHaveBeenCalledTimes(1);
    const token = jwt({ aud: "convex" });
    clerk.session.getToken = vi.fn().mockResolvedValue(token);
    const fetchToken = client.setAuth.mock.calls[0][0];
    expect(await fetchToken({ forceRefreshToken: true })).toBe(token);
    expect(clerk.session.getToken).toHaveBeenCalledWith({ skipCache: true });
    await clerk.signOut();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(client);
  });

  it("a switch to a different session also retires the socket", async () => {
    const client = { setAuth: vi.fn(), close: vi.fn() };
    await clerk.setActive({ session: "sess_1" });
    g.RivetApi._authenticate(client, () => {});
    await vi.waitFor(() => expect(client.setAuth).toHaveBeenCalledTimes(1));
    await clerk.setActive({ session: "sess_2" });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.setAuth).toHaveBeenCalledTimes(1);
  });
});

describe("account recovery privacy", () => {
  it("an unknown email gets the same answer as a known one", async () => {
    clerk.client.signIn.create.mockRejectedValue({ errors: [{ code: "form_identifier_not_found", longMessage: "Couldn't find your account." }] });
    expect(await auth().startPasswordReset("nobody@example.test")).toEqual({ status: "needs_code" });
  });
});

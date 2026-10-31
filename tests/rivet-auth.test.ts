import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// js/rivet-auth.js against a fake Clerk object. This checks our own logic (which
// Clerk calls we make, in what order, and what the page is told). It does NOT
// prove the real Clerk API behaves this way: that needs a live Clerk instance.

const g = globalThis as any;
const auth = () => g.RivetAuth;
const jwt = (claims: object) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

const OK = { error: null };
const E = (code: string, extra: object = {}) => ({ error: Object.assign(new Error(code), { code, errors: [{ code, longMessage: `Clerk says ${code}`, ...extra }] }) });

// Clerk's Future API as js/rivet-auth.js uses it (client.signIn / client.signUp .__internal_future).
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
    _emit: () => listeners.forEach((l) => l()),
  };
  const finalizeFor = (id: string) => vi.fn(async () => { await clerk.setActive({ session: id }); return OK; });
  const signIn: any = {
    status: null, supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_1" }],
    password: vi.fn(), create: vi.fn(), finalize: finalizeFor("sess_si"),
    mfa: { sendEmailCode: vi.fn().mockResolvedValue(OK), verifyEmailCode: vi.fn() },
    resetPasswordEmailCode: { sendCode: vi.fn().mockResolvedValue(OK), verifyCode: vi.fn(), submitPassword: vi.fn() },
  };
  const signUp: any = {
    status: null, missingFields: [] as string[],
    password: vi.fn().mockResolvedValue(OK), finalize: finalizeFor("sess_su"),
    verifications: { sendEmailCode: vi.fn().mockResolvedValue(OK), verifyEmailCode: vi.fn() },
  };
  clerk.client = { signIn: { __internal_future: signIn }, signUp: { __internal_future: signUp } };
  clerk.si = signIn; clerk.su = signUp;
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
    clerk.si.password.mockImplementation(async () => { clerk.si.status = "complete"; return OK; });
    expect(await auth().signIn(" ana@example.test ", "pw-12345678")).toEqual({ status: "complete" });
    expect(clerk.si.password).toHaveBeenCalledWith({ identifier: "ana@example.test", password: "pw-12345678" });
    expect(clerk.si.finalize).toHaveBeenCalled();
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_si" });
  });

  it.each([["needs_client_trust"], ["needs_second_factor"]])("%s sends an email code, then the code completes", async (status) => {
    clerk.si.password.mockImplementation(async () => { clerk.si.status = status; return OK; });
    expect(await auth().signIn("ana@example.test", "pw")).toEqual({ status: "needs_code" });
    expect(clerk.si.mfa.sendEmailCode).toHaveBeenCalled();
    expect(clerk.setActive).not.toHaveBeenCalled();
    clerk.si.mfa.verifyEmailCode.mockImplementation(async () => { clerk.si.status = "complete"; return OK; });
    expect(await auth().verifySignInCode(" 123456 ")).toEqual({ status: "complete" });
    expect(clerk.si.mfa.verifyEmailCode).toHaveBeenCalledWith({ code: "123456" });
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_si" });
  });

  it("a second factor we can't handle is a clear error, not a silent hang", async () => {
    clerk.si.supportedSecondFactors = [{ strategy: "totp" }];
    clerk.si.password.mockImplementation(async () => { clerk.si.status = "needs_second_factor"; return OK; });
    await expect(auth().signIn("a@example.test", "pw")).rejects.toThrow(/doesn't support/);
  });

  it("maps Clerk's errors to plain messages", async () => {
    clerk.si.password.mockResolvedValue(E("form_password_incorrect"));
    await expect(auth().signIn("a@example.test", "bad")).rejects.toThrow("That email and password don't match an account.");
    clerk.si.mfa.verifyEmailCode.mockResolvedValue(E("form_code_incorrect"));
    await expect(auth().verifySignInCode("000000")).rejects.toThrow(/code isn't right/);
    clerk.si.password.mockResolvedValue(E("something_new"));
    await expect(auth().signIn("a@example.test", "pw")).rejects.toThrow("Clerk says something_new");
  });

  it("is a no-op when already signed in", async () => {
    clerk.user = { id: "user_1" }; clerk.session = { id: "s" };
    expect(await auth().signIn("a@example.test", "pw")).toEqual({ status: "complete" });
    expect(clerk.si.password).not.toHaveBeenCalled();
  });
});

describe("sign up and email verification", () => {
  it("creates the sign-up, sends a code, and the code signs in", async () => {
    expect(await auth().signUp({ name: "Ana  María López", email: " ana@example.test ", password: "pw-12345678" }))
      .toEqual({ status: "needs_code" });
    expect(clerk.su.password).toHaveBeenCalledWith({
      emailAddress: "ana@example.test", password: "pw-12345678", firstName: "Ana", lastName: "María López",
    });
    expect(clerk.su.verifications.sendEmailCode).toHaveBeenCalled();
    clerk.su.verifications.verifyEmailCode.mockImplementation(async () => { clerk.su.status = "complete"; return OK; });
    expect(await auth().verifySignUp("424242")).toEqual({ status: "complete" });
    expect(clerk.su.verifications.verifyEmailCode).toHaveBeenCalledWith({ code: "424242" });
    expect(clerk.setActive).toHaveBeenCalledWith({ session: "sess_su" });
  });

  it("retries without names when the instance doesn't collect them", async () => {
    clerk.su.password.mockResolvedValueOnce(E("form_param_unknown", { meta: { paramName: "first_name" } })).mockResolvedValueOnce(OK);
    await auth().signUp({ name: "Ana", email: "a@example.test", password: "pw-12345678" });
    expect(clerk.su.password).toHaveBeenLastCalledWith({ emailAddress: "a@example.test", password: "pw-12345678" });
  });

  it("an incomplete sign-up after the code is an error naming what's missing, never a fake success", async () => {
    clerk.su.verifications.verifyEmailCode.mockImplementation(async () => { clerk.su.status = "missing_requirements"; clerk.su.missingFields = ["protect_check"]; return OK; });
    await expect(auth().verifySignUp("424242")).rejects.toThrow(/needs more details.*protect_check/);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });
});

describe("account recovery", () => {
  it("sends a reset code, then code + new password signs in", async () => {
    clerk.si.create.mockImplementation(async () => { clerk.si.status = "needs_first_factor"; return OK; });
    expect(await auth().startPasswordReset(" ana@example.test ")).toEqual({ status: "needs_code" });
    expect(clerk.si.create).toHaveBeenCalledWith({ identifier: "ana@example.test" });
    expect(clerk.si.resetPasswordEmailCode.sendCode).toHaveBeenCalled();
    clerk.si.resetPasswordEmailCode.verifyCode.mockImplementation(async () => { clerk.si.status = "needs_new_password"; return OK; });
    clerk.si.resetPasswordEmailCode.submitPassword.mockImplementation(async () => { clerk.si.status = "complete"; return OK; });
    expect(await auth().completePasswordReset("111111", "new-pw-123456")).toEqual({ status: "complete" });
    expect(clerk.si.resetPasswordEmailCode.verifyCode).toHaveBeenCalledWith({ code: "111111" });
    expect(clerk.si.resetPasswordEmailCode.submitPassword).toHaveBeenCalledWith({ password: "new-pw-123456" });
    expect(clerk.setActive).toHaveBeenCalled();
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

describe("rivet-api calls wait for sign-in and heal it", () => {
  beforeAll(async () => {
    // @ts-expect-error plain JS, no types
    await import("../js/rivet-api.js");
  });
  afterEach(() => g.RivetApi._setClient(null));
  const NOT_SIGNED_IN = "Please sign in to continue.";
  const NO_ACCOUNT = "Finish setting up your account first.";
  const refusal = (data: string) => Object.assign(new Error("ConvexError"), { data });
  const signedInClerk = () => {
    clerk.session = { id: "sess_1", getToken: vi.fn().mockResolvedValue(jwt({ aud: "convex" })) };
    clerk.user = { id: "user_1", firstName: "Ana", primaryEmailAddress: { emailAddress: "ana@example.test" } };
  };
  // A Convex client whose server confirms (or refuses) the token when told to.
  const fakeConvex = (mutation: any) => {
    const c: any = { mutation, query: vi.fn(), close: vi.fn() };
    c.setAuth = vi.fn((_fetch: any, onAuth: (ok: boolean) => void) => { c.onAuth = onAuth; });
    return c;
  };
  const wire = (c: any) => { g.RivetApi._authenticate(c, () => {}); g.RivetApi._setClient(c); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("a call made while clerk-js is still loading waits until Convex accepted the token", async () => {
    let loaded!: () => void;
    clerk.load = vi.fn(() => new Promise<void>((r) => (loaded = r)));
    signedInClerk();
    const c = fakeConvex(vi.fn().mockResolvedValue("req_1"));
    wire(c);
    const p = g.RivetApi.createRequest({ title: "x" });
    await flush();
    expect(c.mutation).not.toHaveBeenCalled(); // before the fix this went out anonymously
    loaded();
    await vi.waitFor(() => expect(c.setAuth).toHaveBeenCalledTimes(1));
    await flush();
    expect(c.mutation).not.toHaveBeenCalled(); // token sent, not yet confirmed
    c.onAuth(true);
    expect(await p).toBe("req_1");
  });

  it("signed out: the call goes ahead once Clerk has answered, without a token", async () => {
    const c = fakeConvex(vi.fn().mockRejectedValue(refusal(NOT_SIGNED_IN)));
    wire(c);
    const err = await g.RivetApi.createRequest({}).catch((e: any) => e);
    expect(c.setAuth).not.toHaveBeenCalled();
    expect(c.mutation).toHaveBeenCalledTimes(1); // no retry for a real signed-out visitor
    expect(g.RivetApi.friendlyError(err)).toBe(NOT_SIGNED_IN);
  });

  it("re-sends the token when Convex dropped it, before the next call", async () => {
    signedInClerk();
    const c = fakeConvex(vi.fn().mockResolvedValue("ok"));
    wire(c);
    await vi.waitFor(() => expect(c.setAuth).toHaveBeenCalledTimes(1));
    c.onAuth(false); // e.g. one token refresh failed in a sleeping tab
    const p = g.RivetApi.planWorkflow("req_1");
    await vi.waitFor(() => expect(c.setAuth).toHaveBeenCalledTimes(2));
    c.onAuth(true);
    expect(await p).toBe("ok");
    expect(c.mutation).toHaveBeenCalledTimes(1);
  });

  it("refused as signed out while Clerk has a session: re-authenticates and retries once", async () => {
    signedInClerk();
    const mutation = vi.fn().mockRejectedValueOnce(refusal(NOT_SIGNED_IN)).mockResolvedValueOnce("req_1");
    const c = fakeConvex(mutation);
    c.setAuth = vi.fn((_f: any, onAuth: (ok: boolean) => void) => { c.onAuth = onAuth; queueMicrotask(() => onAuth(true)); });
    wire(c);
    expect(await g.RivetApi.createRequest({})).toBe("req_1");
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(c.setAuth).toHaveBeenCalledTimes(2);
  });

  it("still refused after that: says so without telling a signed-in person to sign in", async () => {
    signedInClerk();
    const c = fakeConvex(vi.fn().mockRejectedValue(refusal(NOT_SIGNED_IN)));
    c.setAuth = vi.fn((_f: any, onAuth: (ok: boolean) => void) => queueMicrotask(() => onAuth(true)));
    wire(c);
    const err = await g.RivetApi.createRequest({}).catch((e: any) => e);
    expect(c.mutation).toHaveBeenCalledTimes(2);
    expect(g.RivetApi.friendlyError(err)).not.toMatch(/please sign in/i);
    expect(g.RivetApi.friendlyError(err)).toMatch(/couldn't confirm your sign-in/);
  });

  it("no account row on this backend: creates it, then retries when the role is known", async () => {
    signedInClerk();
    const mutation = vi.fn(async (name: string) => {
      if (name === "users:ensureAccount") return { role: "client" };
      if (mutation.mock.calls.filter((x: any[]) => x[0] === name).length === 1) throw refusal(NO_ACCOUNT);
      return "req_1";
    });
    const c = fakeConvex(mutation);
    c.setAuth = vi.fn((_f: any, onAuth: (ok: boolean) => void) => queueMicrotask(() => onAuth(true)));
    wire(c);
    expect(await g.RivetApi.createRequest({})).toBe("req_1");
    expect(mutation.mock.calls.map((x: any[]) => x[0])).toEqual(["requests:create", "users:ensureAccount", "requests:create"]);
  });

  it("no role yet: the error asks the person to choose how they'll use Rivet", async () => {
    signedInClerk();
    const mutation = vi.fn(async (name: string) => {
      if (name === "users:ensureAccount") return { role: null };
      throw refusal(NO_ACCOUNT);
    });
    const c = fakeConvex(mutation);
    c.setAuth = vi.fn((_f: any, onAuth: (ok: boolean) => void) => queueMicrotask(() => onAuth(true)));
    wire(c);
    const err = await g.RivetApi.createRequest({}).catch((e: any) => e);
    expect(g.RivetApi.needsRole(err)).toBe(true);
    expect(g.RivetApi.friendlyError(err)).toBe("Choose how you'll use Rivet to continue.");
    expect(mutation).toHaveBeenCalledTimes(2); // no role is ever chosen for them
  });
});

describe("nav link while signed in", () => {
  const fakeDoc = () => {
    const attrs: Record<string, string> = {};
    const a: any = {
      textContent: "Log in",
      hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; },
    };
    return { a, attrs, doc: { querySelectorAll: () => [a] } };
  };
  it("reads Account (email in the title) when signed in, and Log in again when signed out", () => {
    const { a, attrs, doc } = fakeDoc();
    expect(auth()._decorateNav({ signedIn: true, email: "ana@example.test" }, doc)).toBe(1);
    expect(a.textContent).toBe("Account");
    expect(attrs.title).toMatch(/ana@example\.test/);
    auth()._decorateNav({ signedIn: false }, doc);
    expect(a.textContent).toBe("Log in");
    expect(attrs.title).toBeUndefined();
  });
});

describe("account recovery privacy", () => {
  it("an unknown email gets the same answer as a known one", async () => {
    clerk.si.create.mockResolvedValue(E("form_identifier_not_found"));
    expect(await auth().startPasswordReset("nobody@example.test")).toEqual({ status: "needs_code" });
    expect(clerk.si.resetPasswordEmailCode.sendCode).not.toHaveBeenCalled();
  });
});

// LOCAL TESTING ONLY. A scripted stand-in for clerk-js, injected into pages by the
// browser test suites before any page script runs. It implements just the clerk-js
// calls js/rivet-auth.js makes, in Clerk's Future API shape (sign-up + email code, sign-in + new-device code,
// password reset, sessions, tokens). Session tokens come from the local test issuer
// (scripts/local-auth-issuer.mjs), so a local Convex backend really verifies them.
// Passing tests prove our pages and Convex's checks, NOT Clerk's own behaviour.
//
// Accounts and the session live in the browser context's localStorage (the session
// survives reloads, like Clerk's cookie). "424242" is the only correct emailed code.
// Page helpers: window.__e2eExpire() ends the session (as an expired or revoked one
// looks to the page), __e2eMarkNewDevice(email), __e2eSub().
import { ConvexHttpClient } from "convex/browser";

export function fakeClerkScript(issuer) {
  return `(() => {
  const ISSUER = ${JSON.stringify(issuer)}, CODE = "424242";
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const put = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const users = () => get("e2e.clerk.users", {});
  const sess = () => get("e2e.clerk.session", null);
  const listeners = [];
  const emit = () => listeners.slice().forEach((f) => { try { f({}); } catch (e) {} });
  const err = (code) => Object.assign(new Error(code), { errors: [{ code, longMessage: "Fake Clerk: " + code }] });
  const E = (code) => ({ error: Object.assign(new Error(code), { code, errors: [{ code, longMessage: "Fake Clerk: " + code }] }) });
  const OK = { error: null };
  const su = { status: null, draft: null, missing: [] };
  const si = { status: null, email: null, u: null };
  const clerk = {
    calls: [],
    load: async () => {},
    get user() { const s = sess(); return s ? { id: s.sub, firstName: "E2E", primaryEmailAddress: { emailAddress: s.email } } : null; },
    get session() {
      const s = sess();
      return s ? { id: s.sid, getToken: async () => {
        const r = await fetch(ISSUER + "/mint?sub=" + encodeURIComponent(s.sub) + "&email=" + encodeURIComponent(s.email));
        return (await r.json()).token;
      } } : null;
    },
    addListener: (f) => { listeners.push(f); return () => listeners.splice(listeners.indexOf(f), 1); },
    setActive: async ({ session }) => { const p = clerk._pending; put("e2e.clerk.session", { sid: session, sub: p.sub, email: p.email }); emit(); },
    // Like real Clerk, navigate to redirectUrl afterwards.
    signOut: async (o) => { localStorage.removeItem("e2e.clerk.session"); emit(); if (o && o.redirectUrl) location.href = o.redirectUrl; },
    client: { signIn: {}, signUp: {} },
  };
  const finalize = async () => { await clerk.setActive({ session: "sess_" + clerk._pending.sub }); return OK; };
  // The Future API, as js/rivet-auth.js uses it (clerk.client.signUp.__internal_future).
  clerk.client.signUp.__internal_future = {
    get status() { return su.status; },
    get missingFields() { return su.missing; },
    password: async (p) => {
      clerk.calls.push("signUp.password");
      if (users()[p.emailAddress]) return E("form_identifier_exists");
      su.draft = p; su.status = "missing_requirements"; return OK;
    },
    verifications: {
      sendEmailCode: async () => { clerk.calls.push("signUp.sendEmailCode"); return OK; },
      verifyEmailCode: async ({ code }) => {
        if (code !== CODE) return E("form_code_incorrect");
        const sub = "user_e2e_" + Math.random().toString(36).slice(2, 10);
        const all = users(); all[su.draft.emailAddress] = { sub, pw: su.draft.password }; put("e2e.clerk.users", all);
        clerk._pending = { sub, email: su.draft.emailAddress }; su.status = "complete"; return OK;
      },
    },
    finalize,
  };
  clerk.client.signIn.__internal_future = {
    get status() { return si.status; },
    get supportedSecondFactors() { return [{ strategy: "email_code", emailAddressId: "idn_e2e" }]; },
    password: async ({ identifier, password }) => {
      clerk.calls.push("signIn.password");
      const u = users()[identifier];
      si.email = identifier; si.u = u;
      if (!u || u.pw !== password) return E("form_password_incorrect");
      clerk._pending = { sub: u.sub, email: identifier };
      si.status = u.newDevice ? "needs_client_trust" : "complete"; return OK;
    },
    mfa: {
      sendEmailCode: async () => { clerk.calls.push("signIn.mfa.sendEmailCode"); return OK; },
      verifyEmailCode: async ({ code }) => {
        if (code !== CODE) return E("form_code_incorrect");
        const all = users(); all[si.email].newDevice = false; put("e2e.clerk.users", all);
        si.status = "complete"; return OK;
      },
    },
    create: async ({ identifier }) => {
      clerk.calls.push("signIn.create");
      si.email = identifier; si.u = users()[identifier];
      if (!si.u) return E("form_identifier_not_found");
      si.status = "needs_first_factor"; return OK;
    },
    resetPasswordEmailCode: {
      sendCode: async () => { clerk.calls.push("signIn.reset.sendCode"); return OK; },
      verifyCode: async ({ code }) => { if (code !== CODE) return E("form_code_incorrect"); si.status = "needs_new_password"; return OK; },
      submitPassword: async ({ password }) => {
        const all = users(); all[si.email].pw = password; put("e2e.clerk.users", all);
        clerk._pending = { sub: si.u.sub, email: si.email }; si.status = "complete"; return OK;
      },
    },
    finalize,
  };
  window.Clerk = clerk;
  window.__e2eExpire = () => clerk.signOut();
  window.__e2eMarkNewDevice = (email) => { const all = users(); all[email].newDevice = true; put("e2e.clerk.users", all); };
  window.__e2eSub = () => (sess() || {}).sub;
})();`;
}

// Preload that starts the tab already signed in as `account` (from makeAccount).
export const signedInScript = (account) =>
  `localStorage.setItem("e2e.clerk.session", ${JSON.stringify(JSON.stringify({ sid: "sess_" + account.sub, sub: account.sub, email: account.email }))});`;

export async function mintToken(issuer, sub, email) {
  const r = await fetch(`${issuer}/mint?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(email)}`);
  return (await r.json()).token;
}

// A ready-made account on the local backend, as if the person had signed up and
// picked a role on the signup page. Developers still need approving (CLI).
export async function makeAccount({ convexUrl, issuer, role, label }) {
  const sub = `user_e2e_${label}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `${sub}@example.test`;
  const c = new ConvexHttpClient(convexUrl);
  c.setAuth(await mintToken(issuer, sub, email));
  await c.mutation("users:chooseRole", { role });
  return { sub, email };
}

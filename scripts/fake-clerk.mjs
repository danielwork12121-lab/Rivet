// LOCAL TESTING ONLY. A scripted stand-in for clerk-js, injected into pages by the
// browser test suites before any page script runs. It implements just the clerk-js
// calls js/rivet-auth.js makes (sign-up + email code, sign-in + new-device code,
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
  let signUpDraft = null, signInDraft = null;
  const done = (sub, email) => ({ status: "complete", createdSessionId: "sess_" + sub });
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
    signOut: async () => { localStorage.removeItem("e2e.clerk.session"); emit(); },
    client: {
      signUp: {
        create: async (p) => { clerk.calls.push("signUp.create"); if (users()[p.emailAddress]) throw err("form_identifier_exists"); signUpDraft = p; return {}; },
        prepareEmailAddressVerification: async () => { clerk.calls.push("signUp.prepare"); return {}; },
        attemptEmailAddressVerification: async ({ code }) => {
          if (code !== CODE) throw err("form_code_incorrect");
          const sub = "user_e2e_" + Math.random().toString(36).slice(2, 10);
          const all = users(); all[signUpDraft.emailAddress] = { sub, pw: signUpDraft.password }; put("e2e.clerk.users", all);
          clerk._pending = { sub, email: signUpDraft.emailAddress };
          return done(sub, signUpDraft.emailAddress);
        },
      },
      signIn: {
        supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_e2e" }],
        create: async (p) => {
          clerk.calls.push("signIn.create:" + (p.strategy || "password"));
          const u = users()[p.identifier];
          signInDraft = { email: p.identifier, u };
          if (p.strategy === "reset_password_email_code") return { status: "needs_first_factor" };
          if (!u || u.pw !== p.password) throw err("form_password_incorrect");
          clerk._pending = { sub: u.sub, email: p.identifier };
          if (u.newDevice) return { status: "needs_client_trust", supportedSecondFactors: [{ strategy: "email_code", emailAddressId: "idn_e2e" }] };
          return done(u.sub, p.identifier);
        },
        prepareSecondFactor: async () => { clerk.calls.push("signIn.prepareSecondFactor"); return {}; },
        attemptSecondFactor: async ({ code }) => {
          if (code !== CODE) throw err("form_code_incorrect");
          const all = users(); all[signInDraft.email].newDevice = false; put("e2e.clerk.users", all);
          return done(signInDraft.u.sub, signInDraft.email);
        },
        attemptFirstFactor: async ({ code, password }) => {
          if (code !== CODE) throw err("form_code_incorrect");
          const all = users(); all[signInDraft.email].pw = password; put("e2e.clerk.users", all);
          clerk._pending = { sub: signInDraft.u.sub, email: signInDraft.email };
          return done(signInDraft.u.sub, signInDraft.email);
        },
      },
    },
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

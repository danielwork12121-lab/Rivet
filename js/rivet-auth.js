// Rivet sign-in, built on Clerk's browser SDK (clerk-js), with the pages' own
// forms instead of Clerk's prebuilt UI. Classic script (no import/export).
// Exposes `RivetAuth` on the global object. Load after js/rivet-config.js.
//
// Clerk owns everything about identity: passwords, email verification codes,
// sessions, refresh and expiry. Nothing here stores a password or a token.
// What a signed-in person may do is decided by Convex (convex/lib/auth.ts),
// never by this file.
//
// Uses Clerk's Future API (SignInFuture / SignUpFuture) through the __internal_future
// handle on client.signIn / client.signUp, because it is the one that resolves Clerk
// Protect bot challenges. If Clerk exposes it publicly later, only this file changes.
(function (root) {
  "use strict";

  var CLERK_JS_PATH = "/npm/@clerk/clerk-js@6/dist/clerk.browser.js"; // major pin, as Clerk recommends
  // Clerk's UI bundle. Our forms replace Clerk's prebuilt screens, but clerk-js still
  // needs it to show bot-protection ("Protect") challenges, which sign-up can require
  // (otherwise sign-up ends with the missing requirement "protect_check").
  var CLERK_UI_PATH = "/npm/@clerk/ui@1/dist/ui.browser.js";
  var LOAD_TIMEOUT_MS = 20000;

  // A publishable key is "pk_(test|live)_" + base64("<frontend api host>$").
  function frontendApi(key) {
    var m = /^pk_(test|live)_([A-Za-z0-9+/=]+)$/.exec(String(key || ""));
    if (!m) return null;
    try { return root.atob(m[2]).replace(/\$$/, ""); } catch (e) { return null; }
  }

  var loading = null;
  // Resolves with the loaded Clerk instance. A page (or a test) may provide its
  // own `window.Clerk` before this script; otherwise clerk-js is fetched from this
  // instance's Frontend API, the way Clerk's own script-tag snippet does.
  function ready() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (root.Clerk && typeof root.Clerk.load === "function") return resolve(root.Clerk);
      var key = root.RIVET_CLERK_PUBLISHABLE_KEY, host = frontendApi(key);
      if (!host) return reject(new Error("Sign-in is not configured (missing Clerk publishable key)."));
      var timer = setTimeout(function () { reject(new Error("Sign-in took too long to load. Check your connection and reload.")); }, LOAD_TIMEOUT_MS);
      var add = function (path, withKey) {
        return new Promise(function (ok, bad) {
          var s = root.document.createElement("script");
          s.src = "https://" + host + path;
          s.async = true;
          s.crossOrigin = "anonymous";
          if (withKey) s.setAttribute("data-clerk-publishable-key", key);
          s.onload = ok;
          s.onerror = function () { bad(new Error("Couldn't load sign-in. Check your connection and reload.")); };
          (root.document.head || root.document.documentElement).appendChild(s);
        });
      };
      // The UI bundle first, then clerk-js (same order as Clerk's own snippet).
      add(CLERK_UI_PATH, false).catch(function () { /* optional: only needed for Protect challenges */ })
        .then(function () { return add(CLERK_JS_PATH, true); })
        .then(function () { clearTimeout(timer); root.Clerk ? resolve(root.Clerk) : reject(new Error("Sign-in failed to start.")); }, function (e) { clearTimeout(timer); reject(e); });
    })
      .then(function (clerk) {
        var ui = root.__internal_ClerkUICtor;
        return Promise.resolve(clerk.load(ui ? { ui: { ClerkUI: ui } } : undefined)).then(function () { return clerk; });
      })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  // ---- state ------------------------------------------------------------------------
  function state(clerk) {
    var u = clerk && clerk.user;
    if (!u || !clerk.session) return { signedIn: false, sessionId: null, userId: null, email: null, firstName: null };
    return {
      signedIn: true,
      sessionId: clerk.session.id,
      userId: u.id,
      email: (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || null,
      firstName: u.firstName || null,
    };
  }
  function current() { return ready().then(state); }

  // Calls fn(state) now and whenever the signed-in session changes (sign-in,
  // sign-out, expiry, another tab signing out). Returns an unsubscribe function.
  function onChange(fn) {
    var last = null, off = null, stopped = false;
    ready().then(function (clerk) {
      if (stopped) return;
      var emit = function () {
        var st = state(clerk), sig = st.sessionId + "|" + st.userId;
        if (sig === last) return;
        last = sig;
        fn(st);
      };
      off = clerk.addListener(emit);
      emit();
    }, function () { if (!stopped) fn(state(null)); });
    return function () { stopped = true; if (typeof off === "function") off(); };
  }

  // ---- tokens for Convex ---------------------------------------------------------------
  function claimsOf(jwt) {
    try {
      var part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(root.atob(part + "===".slice((part.length + 3) % 4)));
    } catch (e) { return null; }
  }
  function hasConvexAudience(jwt) {
    var aud = (claimsOf(jwt) || {}).aud;
    return aud === "convex" || (Array.isArray(aud) && aud.indexOf("convex") !== -1);
  }
  // The session token Convex accepts, or null when signed out. With Clerk's Convex
  // integration the default session token already has audience "convex"; older
  // setups use a JWT template named "convex" (same rule as convex/react-clerk).
  function getToken(opts) {
    var skipCache = !!(opts && opts.forceRefresh);
    return ready().then(function (clerk) {
      if (!clerk.session) return null;
      return clerk.session.getToken({ skipCache: skipCache }).then(function (jwt) {
        if (!jwt || hasConvexAudience(jwt)) return jwt || null;
        return clerk.session.getToken({ template: "convex", skipCache: skipCache });
      });
    }).catch(function () { return null; });
  }

  // ---- errors --------------------------------------------------------------------------
  // Clerk's methods return { error } instead of throwing; must() turns that into a throw.
  // Errors carry a code (and, for API errors, errors[].longMessage written for end users).
  function must(res) { if (res && res.error) throw res.error; return res; }
  function firstError(err) { return (err && err.errors && err.errors[0]) || (err && err.code ? err : null); }
  function friendly(err) {
    var e = firstError(err);
    if (e) {
      if (e.code === "form_code_incorrect") return "That code isn't right. Check the email and try again.";
      if (e.code === "verification_expired") return "That code has expired. Send a new one.";
      if (e.code === "form_password_pwned") return "That password has appeared in a data breach. Please choose a different one.";
      if (e.code === "form_identifier_not_found" || e.code === "form_password_incorrect") return "That email and password don't match an account.";
      return e.longMessage || e.message || "Something went wrong. Please try again.";
    }
    return (err && err.message) || "Something went wrong. Please try again.";
  }
  function fail(msg) { var e = new Error(msg); e.rivetAuth = true; return e; }
  function rethrow(err) { throw err && err.rivetAuth ? err : fail(friendly(err)); }

  // Clerk's Future API (the replacement for the "legacy" client.signIn / client.signUp
  // methods). Only it resolves Clerk Protect bot challenges, in a modal from the UI bundle
  // loaded above; the legacy methods leave sign-up stuck on "protect_check". It is
  // exposed to plain JS as __internal_future, the same handle Clerk's own hooks use.
  function signInF(clerk) { return clerk.client.signIn.__internal_future; }
  function signUpF(clerk) { return clerk.client.signUp.__internal_future; }
  var stay = function () {}; // we redirect ourselves; don't let finalize() navigate

  // ---- sign in ------------------------------------------------------------------------
  // Each step resolves with { status: "complete" } (now signed in) or
  // { status: "needs_code" } (Clerk emailed a code: call verifySignInCode).
  function afterSignInStep(clerk, si) {
    if (si.status === "complete") {
      return Promise.resolve(si.finalize({ navigate: stay })).then(function (r) { must(r); return { status: "complete" }; });
    }
    // A new device (Clerk's Device Trust) or email-code 2FA: send the code.
    if (si.status === "needs_second_factor" || si.status === "needs_client_trust") {
      var factor = (si.supportedSecondFactors || []).find(function (f) { return f.strategy === "email_code"; });
      if (!factor) throw fail("This account needs a sign-in method this page doesn't support yet.");
      return Promise.resolve(si.mfa.sendEmailCode()).then(function (r) { must(r); return { status: "needs_code" }; });
    }
    if (si.status === "needs_new_password") return { status: "needs_new_password" };
    throw fail("Sign-in couldn't be completed. Please try again.");
  }

  function signIn(email, password) {
    return ready().then(function (clerk) {
      if (clerk.user) return { status: "complete" };
      var si = signInF(clerk);
      return Promise.resolve(si.password({ identifier: String(email).trim(), password: String(password) }))
        .then(function (r) { must(r); return afterSignInStep(clerk, si); });
    }).catch(rethrow);
  }
  function verifySignInCode(code) {
    return ready().then(function (clerk) {
      var si = signInF(clerk);
      return Promise.resolve(si.mfa.verifyEmailCode({ code: String(code).trim() }))
        .then(function (r) { must(r); return afterSignInStep(clerk, si); });
    }).catch(rethrow);
  }
  function resendSignInCode() {
    return ready().then(function (clerk) { return signInF(clerk).mfa.sendEmailCode(); })
      .then(function (r) { must(r); return { status: "needs_code" }; }).catch(rethrow);
  }

  // ---- sign up -------------------------------------------------------------------------
  // signUp sends an email code; verifySignUp completes the account and signs in.
  function signUp(fields) {
    return ready().then(function (clerk) {
      var su = signUpF(clerk);
      var names = String(fields.name || "").trim().split(/\s+/);
      var params = { emailAddress: String(fields.email).trim(), password: String(fields.password) };
      if (names[0]) params.firstName = names[0];
      if (names.length > 1) params.lastName = names.slice(1).join(" ");
      return Promise.resolve(su.password(params))
        .then(function (r) { must(r); return su.verifications.sendEmailCode(); })
        .then(function (r) { must(r); return { status: "needs_code" }; });
    }).catch(function (err) {
      // Some instances don't collect names: retry once without them.
      var e = firstError(err);
      if (e && e.code === "form_param_unknown" && /name/i.test(String((e.meta && e.meta.paramName) || e.message || "")) && fields.name) {
        return signUp({ email: fields.email, password: fields.password });
      }
      return rethrow(err);
    });
  }
  function verifySignUp(code) {
    return ready().then(function (clerk) {
      var su = signUpF(clerk);
      // With the UI bundle loaded, a Protect challenge (if the instance uses one) is
      // resolved in a modal before this returns.
      return Promise.resolve(su.verifications.verifyEmailCode({ code: String(code).trim() })).then(function (r) {
        must(r);
        if (su.status !== "complete") {
          throw fail("Your account needs more details than this page asks for"
            + ((su.missingFields && su.missingFields.length) ? " (" + su.missingFields.join(", ") + ")" : "") + ". Please contact Rivet.");
        }
        return su.finalize({ navigate: stay });
      }).then(function (r) { must(r); return { status: "complete" }; });
    }).catch(rethrow);
  }
  function resendSignUpCode() {
    return ready().then(function (clerk) { return signUpF(clerk).verifications.sendEmailCode(); })
      .then(function (r) { must(r); return { status: "needs_code" }; }).catch(rethrow);
  }

  // ---- account recovery ---------------------------------------------------------------
  // Same answer whether or not the email has an account, so the form can't be used to
  // find out who has one (the page says "If <email> has a Rivet account, we emailed it a code").
  function startPasswordReset(email) {
    return ready().then(function (clerk) {
      var si = signInF(clerk);
      return Promise.resolve(si.create({ identifier: String(email).trim() }))
        .then(function (r) { must(r); return si.resetPasswordEmailCode.sendCode(); })
        .then(function (r) { must(r); return { status: "needs_code" }; });
    }).catch(function (err) {
      var e = firstError(err);
      if (e && e.code === "form_identifier_not_found") return { status: "needs_code" };
      return rethrow(err);
    });
  }
  // Verifies the emailed code and sets the new password; signs in on success.
  function completePasswordReset(code, password) {
    return ready().then(function (clerk) {
      var si = signInF(clerk);
      return Promise.resolve(si.resetPasswordEmailCode.verifyCode({ code: String(code).trim() }))
        .then(function (r) { must(r); return si.resetPasswordEmailCode.submitPassword({ password: String(password) }); })
        .then(function (r) { must(r); return afterSignInStep(clerk, si); });
    }).catch(rethrow);
  }

  // Clerk's signOut() navigates away afterwards (by default to the site root). Send it
  // to our login page, which says "You've been signed out" (?reason=signed_out).
  function signOut() {
    return ready().then(function (clerk) {
      var to = new root.URL(pageUrl("login") + "?reason=signed_out", root.location.href).href;
      return clerk.signOut({ redirectUrl: to });
    });
  }

  // ---- page helpers ---------------------------------------------------------------------
  // A page in pages/, reachable both as /pages/x.html and from a clean URL (/x).
  function pageUrl(name) {
    var path = (root.location && root.location.pathname) || "";
    var inPages = /\/pages\/[^/]*$/.test(path) || (root.location && root.location.protocol === "file:");
    return (inPages ? "" : "/pages/") + name + ".html";
  }

  root.RivetAuth = {
    ready: ready,
    current: current,
    onChange: onChange,
    getToken: getToken,
    signIn: signIn,
    verifySignInCode: verifySignInCode,
    resendSignInCode: resendSignInCode,
    signUp: signUp,
    verifySignUp: verifySignUp,
    resendSignUpCode: resendSignUpCode,
    startPasswordReset: startPasswordReset,
    completePasswordReset: completePasswordReset,
    signOut: signOut,
    friendly: friendly,
    pageUrl: pageUrl,
    _frontendApi: frontendApi, // tests only
    _hasConvexAudience: hasConvexAudience, // tests only
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

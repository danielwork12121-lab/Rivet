// Rivet sign-in, built on Clerk's browser SDK (clerk-js), with the pages' own
// forms instead of Clerk's prebuilt UI. Classic script (no import/export).
// Exposes `RivetAuth` on the global object. Load after js/rivet-config.js.
//
// Clerk owns everything about identity: passwords, email verification codes,
// sessions, refresh and expiry. Nothing here stores a password or a token.
// What a signed-in person may do is decided by Convex (convex/lib/auth.ts),
// never by this file.
//
// Uses Clerk's documented resource API (client.signIn / client.signUp). Clerk
// marks it "legacy" in favour of SignInFuture, which plain JS can't reach yet
// without internals; moving later only touches this file.
(function (root) {
  "use strict";

  var CLERK_JS_PATH = "/npm/@clerk/clerk-js@6/dist/clerk.browser.js"; // major pin, as Clerk recommends
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
      var s = root.document.createElement("script");
      s.src = "https://" + host + CLERK_JS_PATH;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.setAttribute("data-clerk-publishable-key", key);
      var timer = setTimeout(function () { reject(new Error("Sign-in took too long to load. Check your connection and reload.")); }, LOAD_TIMEOUT_MS);
      s.onload = function () { clearTimeout(timer); root.Clerk ? resolve(root.Clerk) : reject(new Error("Sign-in failed to start.")); };
      s.onerror = function () { clearTimeout(timer); reject(new Error("Couldn't load sign-in. Check your connection and reload.")); };
      (root.document.head || root.document.documentElement).appendChild(s);
    })
      .then(function (clerk) { return Promise.resolve(clerk.load()).then(function () { return clerk; }); })
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
  // Clerk API errors carry errors[].longMessage; those are written for end users.
  function friendly(err) {
    var e = err && err.errors && err.errors[0];
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

  // ---- sign in ------------------------------------------------------------------------
  // Each step resolves with { status: "complete" } (now signed in) or
  // { status: "needs_code" } (Clerk emailed a code: call verifySignInCode).
  function finish(clerk, attempt) {
    return Promise.resolve(clerk.setActive({ session: attempt.createdSessionId })).then(function () {
      return { status: "complete" };
    });
  }
  // A new device (Clerk's Device Trust) or email-code 2FA: send the code.
  function sendSecondFactorCode(clerk, attempt) {
    var factor = (attempt.supportedSecondFactors || []).find(function (f) { return f.strategy === "email_code"; });
    if (!factor) throw fail("This account needs a sign-in method this page doesn't support yet.");
    return Promise.resolve(clerk.client.signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId }))
      .then(function () { return { status: "needs_code" }; });
  }
  function afterSignInStep(clerk, attempt) {
    if (attempt.status === "complete") return finish(clerk, attempt);
    if (attempt.status === "needs_second_factor" || attempt.status === "needs_client_trust") return sendSecondFactorCode(clerk, attempt);
    if (attempt.status === "needs_new_password") return { status: "needs_new_password" };
    throw fail("Sign-in couldn't be completed. Please try again.");
  }

  function signIn(email, password) {
    return ready().then(function (clerk) {
      if (clerk.user) return { status: "complete" };
      return clerk.client.signIn.create({ identifier: String(email).trim(), password: String(password) })
        .then(function (attempt) { return afterSignInStep(clerk, attempt); });
    }).catch(rethrow);
  }
  function verifySignInCode(code) {
    return ready().then(function (clerk) {
      return clerk.client.signIn.attemptSecondFactor({ strategy: "email_code", code: String(code).trim() })
        .then(function (attempt) { return afterSignInStep(clerk, attempt); });
    }).catch(rethrow);
  }
  function resendSignInCode() {
    return ready().then(function (clerk) { return sendSecondFactorCode(clerk, clerk.client.signIn); }).catch(rethrow);
  }

  // ---- sign up -------------------------------------------------------------------------
  // signUp sends an email code; verifySignUp completes the account and signs in.
  function signUp(fields) {
    return ready().then(function (clerk) {
      var names = String(fields.name || "").trim().split(/\s+/);
      var params = { emailAddress: String(fields.email).trim(), password: String(fields.password) };
      if (names[0]) params.firstName = names[0];
      if (names.length > 1) params.lastName = names.slice(1).join(" ");
      return clerk.client.signUp.create(params)
        .then(function () { return clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" }); })
        .then(function () { return { status: "needs_code" }; });
    }).catch(function (err) {
      // Some instances don't collect names: retry once without them.
      var e = err && err.errors && err.errors[0];
      if (e && e.code === "form_param_unknown" && /name/i.test(String(e.meta && e.meta.paramName))) {
        return signUp({ email: fields.email, password: fields.password });
      }
      return rethrow(err);
    });
  }
  function verifySignUp(code) {
    return ready().then(function (clerk) {
      return clerk.client.signUp.attemptEmailAddressVerification({ code: String(code).trim() }).then(function (attempt) {
        if (attempt.status === "complete") return finish(clerk, attempt);
        throw fail("Your account needs more details than this page asks for. Please contact Rivet.");
      });
    }).catch(rethrow);
  }
  function resendSignUpCode() {
    return ready().then(function (clerk) {
      return clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    }).then(function () { return { status: "needs_code" }; }).catch(rethrow);
  }

  // ---- account recovery ---------------------------------------------------------------
  // Same answer whether or not the email has an account, so the form can't be used to
  // find out who has one (the page says "If <email> has a Rivet account, we emailed it a code").
  function startPasswordReset(email) {
    return ready().then(function (clerk) {
      return clerk.client.signIn.create({ strategy: "reset_password_email_code", identifier: String(email).trim() });
    }).then(function () { return { status: "needs_code" }; }, function (err) {
      var e = err && err.errors && err.errors[0];
      if (e && e.code === "form_identifier_not_found") return { status: "needs_code" };
      return rethrow(err);
    });
  }
  // Verifies the emailed code and sets the new password; signs in on success.
  function completePasswordReset(code, password) {
    return ready().then(function (clerk) {
      return clerk.client.signIn.attemptFirstFactor({
        strategy: "reset_password_email_code", code: String(code).trim(), password: String(password),
      }).then(function (attempt) { return afterSignInStep(clerk, attempt); });
    }).catch(rethrow);
  }

  function signOut() {
    return ready().then(function (clerk) { return clerk.signOut(); });
  }

  function rethrow(err) { throw err && err.rivetAuth ? err : fail(friendly(err)); }

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

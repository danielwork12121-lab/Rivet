// Rivet frontend <-> Convex glue. Classic script (no import/export) so it works
// from file:// as well as http://. Exposes `RivetApi` on the global object.
//
// Backend: js/rivet-config.js sets `window.RIVET_BACKEND` ("local" | "cloud" | "custom") and, on this
// machine, `window.RIVET_CONVEX_URL`. A hosted page asks /api/config (CONVEX_URL in Vercel) instead.
// Fictional demo data only. Accounts: when js/rivet-auth.js is loaded, every call
// carries the signed-in person's Clerk session token and Convex decides what they
// may do (convex/lib/auth.ts). Nothing in the browser grants access.
(function (root) {
  "use strict";

  var CONVEX_ESM = "https://esm.sh/convex@1.48.0/browser"; // pinned, matches package.json
  var DEFAULT_URL = "http://127.0.0.1:3210";
  var BACKEND = root.RIVET_BACKEND || "local";
  // One saved draft per backend, so a cloud draft is never sent to a local backend.
  // Which of the account's requests this browser is editing: {"id": "..."}. Only a
  // UI choice (without it the page opens the newest one): the backend checks ownership.
  var CURRENT_KEY = "rivet.intake.current." + BACKEND;
  // A draft saved before accounts ({"id", "token"}): claimed once into the account.
  var DRAFT_KEY = "rivet.intake.draft." + BACKEND;
  // Older keys: an id-only key and an un-namespaced draft that can't be tied to a backend.
  var LEGACY_KEYS = ["rivet.intake.requestId", "rivet.intake.draft"];
  var TIMEOUT_MS = 15000;
  var DRAFT_NOT_FOUND = "Draft not found"; // backend error text for an unknown id or someone else's request
  // Backend access errors (convex/lib/auth.ts), shown as-is.
  var AUTH_ERRORS = {
    signIn: "Please sign in to continue.",
    noAccount: "Finish setting up your account first.",
    clientOnly: "This needs a Client account.",
    developerOnly: "This needs an approved Developer account.",
  };

  var NEEDS_ROLE = "Choose how you'll use Rivet to continue.";

  var BUSINESS_LABELS = { lawn: "Lawn care", pest: "Pest control" };
  // Units for the frontend's illustrative numbers. Questions not listed here have
  // no unit (e.g. the obstacle multiplier, which is a modelling factor).
  var ASSUMPTION_UNITS = { slope: "degrees", weeks: "weeks per year" };

  // ---- mapping: intake state -> requests:create / updateIntake args -----------------
  // `S` is the page's state object. Nothing here touches the DOM or the network.
  function intakeToRequest(S, clientToken) {
    var label = BUSINESS_LABELS[S.type] || String(S.type);
    var name = String(S.name || "").trim();
    var isLawn = S.type === "lawn";
    var staff = isLawn
      ? S.crews + (S.crews === 1 ? " crew" : " crews") + " of " + S.perCrew + (S.perCrew === 1 ? " person" : " people")
      : S.crews + (S.crews === 1 ? " tech" : " techs");
    var args = {
      // Derived: the intake form has no title/environment field, the backend requires both.
      title: name.slice(0, 70).trim() + " — " + label + " automation request",
      description: String(S.describe || ""),
      environment: label + " operation, " + S.region + " region, " + staff + ".",
      constraints: [],
      profile: {
        companyName: name,
        businessType: String(S.type),
        region: String(S.region),
        crewCount: S.crews,
        hourlyLaborCost: S.wage,
        visibility: S.visibility === "anon" ? "anonymous" : "shared",
      },
    };
    if (isLawn) args.profile.peoplePerCrew = S.perCrew;
    if (clientToken) args.clientToken = clientToken;
    return args;
  }

  // Stored draft -> partial page state, or null if it has no usable profile.
  // Strings are returned raw: callers must escape (esc()) or use textContent.
  function requestToIntake(doc) {
    if (!doc || !doc.profile) return null;
    var p = doc.profile;
    var out = {
      type: p.businessType,
      name: p.companyName,
      describe: doc.description,
      crews: p.crewCount,
      wage: p.hourlyLaborCost,
      region: p.region,
      visibility: p.visibility === "anonymous" ? "anon" : "shared",
    };
    if (p.peoplePerCrew !== undefined) out.perCrew = p.peoplePerCrew;
    return out;
  }

  // ---- mapping: follow-up answers ----------------------------------------------------
  // Only the first `S.answered` questions were actually picked by the user; the page
  // pre-fills S.answers with defaults that must never be saved as answers.
  function followUpsFromState(S, questions) {
    var answers = [];
    for (var i = 0; i < Math.min(S.answered, questions.length); i++) {
      var q = questions[i];
      var value = S.answers[q.key];
      var opt = q.opts.find(function (o) { return o[1] === value; });
      if (!opt) break;
      var assumption = { value: value };
      if (ASSUMPTION_UNITS[q.key]) assumption.unit = ASSUMPTION_UNITS[q.key];
      answers.push({ key: q.key, question: q.q, answerLabel: opt[0], assumption: assumption });
    }
    return { answers: answers, complete: answers.length === questions.length };
  }

  // Saved answers -> { answers: {key: value}, answered: n } for the page, matching on
  // the raw label the user picked. Stops at the first question that can't be matched,
  // because the page asks questions in order.
  function followUpsToState(saved, questions) {
    var answers = {};
    var answered = 0;
    var byKey = {};
    (saved || []).forEach(function (a) { byKey[a.key] = a; });
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      var a = byKey[q.key];
      var opt = a && q.opts.find(function (o) { return o[0] === a.answerLabel; });
      if (!opt) break;
      answers[q.key] = opt[1];
      answered++;
    }
    return { answers: answers, answered: answered };
  }

  // ---- mapping: catalog ---------------------------------------------------------------
  // Convex robots -> the page's PRODUCTS shape. Only rows that mirror the page's sample
  // products (they carry sampleKey + taskKey) are returned, in the page's p1..pN order.
  function robotsToProducts(robots) {
    return (robots || [])
      .filter(function (r) { return r.sampleKey && r.taskKey; })
      .sort(function (a, b) { return a.sampleKey.localeCompare(b.sampleKey, "en", { numeric: true }); })
      .map(function (r) {
        return {
          id: r.sampleKey, robotId: r._id, task: r.taskKey, name: r.name, maker: r.vendor,
          price: r.price, opex: r.yearlyOpex, share: r.automationShare, slope: r.slopeLimitDeg,
          regions: (r.regions || []).slice(), trl: r.trl, sample: r.sample,
        };
      });
  }

  // ---- mapping: bounties --------------------------------------------------------------
  // A public posted bounty -> the shape the Developer board's cards use. Returns null
  // for a task the page doesn't know (it couldn't compute skills or a fit for it).
  // Text stays raw; the page escapes it when rendering.
  function toBoardBounty(p, taskSkills, categories) {
    var skills = taskSkills[p.taskKey];
    if (!skills) return null;
    return {
      id: "saved-" + p._id,
      saved: true, // a real saved demo submission, not page sample data
      title: p.title,
      industry: p.industry || "",
      cat: categories[p.taskKey] || "",
      region: p.region || "",
      pledged: p.pledged,
      goal: p.goal,
      backers: 1,
      closes: "\u2014",
      skills: skills.slice(),
      specs: (p.specLines || []).slice(),
    };
  }

  // The operator's own posted bounties (newest first) -> page state for the first one
  // whose task exists for their business type, or null.
  function bountyToState(posted, taskIds) {
    var b = (posted || []).find(function (x) { return taskIds.indexOf(x.taskKey) !== -1; });
    if (!b) return null;
    return {
      id: b._id,
      bounty: { taskId: b.taskKey, product: null },
      gaps: (b.gaps || []).slice(),
      gapNote: b.note || "",
      pledgePct: typeof b.pledgePercent === "number" ? b.pledgePercent : 30,
      pledged: b.pledged, // what was saved; the page shows this rather than recomputing
    };
  }

  // Cheap client-side check so obvious mistakes don't cost a round trip.
  // The backend re-validates everything; this is only for friendlier messages.
  function precheck(S) {
    if (!String(S.name || "").trim()) return "Please enter your company name.";
    if (!String(S.describe || "").trim()) return "Please describe a normal week before continuing.";
    return null;
  }

  // ---- errors ---------------------------------------------------------------------
  function isDraftMissing(err) { return !!err && err.data === DRAFT_NOT_FOUND; }
  // "signIn" | "noAccount" | "clientOnly" | "developerOnly" | null
  function authProblem(err) {
    var d = err && err.data;
    for (var k in AUTH_ERRORS) if (AUTH_ERRORS[k] === d) return k;
    // The socket refused a token (e.g. expired and couldn't be refreshed).
    if (/Unauthenticated|InvalidAuthHeader|NoAuthProvider/.test(String((err && err.message) || ""))) return "signIn";
    return null;
  }

  function friendlyError(err) {
    if (isDraftMissing(err)) return "Your saved request could not be found. Press the button again to save it as a new request.";
    if (authProblem(err) === "signIn" && err && err.rivetSignedIn) return "Rivet couldn't confirm your sign-in. Reload the page; if this keeps happening, log out and back in.";
    if (needsRole(err)) return NEEDS_ROLE;
    if (authProblem(err) === "signIn" && !(err && typeof err.data === "string")) return "Your session has ended. Please sign in again.";
    if (err && typeof err.data === "string") return err.data; // ConvexError from validation
    if (err && err.name === "RivetTimeout") {
      return "The server took too long to respond. Your answers may or may not have been saved. Press the button again; it will not create a duplicate.";
    }
    var msg = String((err && err.message) || "");
    if (/Request ID|Server Error|ArgumentValidation/i.test(msg)) {
      return "The server rejected that request. Please check the fields and try again.";
    }
    return "Can't reach the Rivet server. Check that the backend is running and try again.";
  }

  // ---- client ---------------------------------------------------------------------
  // ConvexClient (WebSocket): request/response calls plus live subscriptions
  // (watchPostedBounties). Authenticated with the Clerk session when RivetAuth is
  // loaded: Convex asks for a fresh token when one expires, and calls wait until
  // the current one has been sent, so nothing runs as the wrong person.
  //
  // Sign-out or a different session closes the socket instead of trying to
  // de-authenticate it: with convex 1.48 a socket kept acting as the old user after
  // setAuth(() => null) and clearAuth() (checked against a local backend). The next
  // call opens a fresh connection with the new session, if any.
  //
  // Calls wait until the socket's sign-in state is settled: Clerk has said whether
  // anyone is signed in and, if so, Convex has accepted or refused the token. Without
  // that wait, a call made while clerk-js was still loading went out anonymously and
  // was refused with "Please sign in" even though the person was signed in. If Convex
  // drops the token later (a token fetch that failed once, e.g. in a sleeping tab, makes
  // convex 1.48 fall back to anonymous for good), the next call re-sends it, and a call
  // refused as signed-out while Clerk still has a session is retried once after
  // re-authenticating. That retry is safe: the backend refuses before changing anything.
  var injected = null;
  var clientPromise = null;
  var AUTH_WAIT_MS = 8000; // never hold a call longer than this waiting for sign-in to settle
  var authOf = typeof WeakMap === "function" ? new WeakMap() : null;

  function authenticate(client, onEnded) {
    var auth = root.RivetAuth;
    var rec = { known: !auth, signedIn: false, confirmed: null, waiters: [] };
    rec.settled = function () { return rec.known && (!rec.signedIn || rec.confirmed !== null); };
    var wake = function () {
      if (!rec.settled()) return;
      var w = rec.waiters; rec.waiters = [];
      w.forEach(function (f) { f(); });
    };
    rec.ready = function () {
      if (rec.settled()) return Promise.resolve(rec);
      return new Promise(function (resolve) {
        var done = function () { clearTimeout(t); resolve(rec); };
        var t = setTimeout(function () { rec.waiters = rec.waiters.filter(function (f) { return f !== done; }); resolve(rec); }, AUTH_WAIT_MS);
        rec.waiters.push(done);
      });
    };
    // (Re)sends the session token; Convex reports back whether it accepted it.
    rec.arm = function () {
      rec.confirmed = null;
      client.setAuth(function (o) {
        var force = !!(o && o.forceRefreshToken);
        return auth.getToken({ forceRefresh: force }).then(function (t) {
          if (t) return t;
          // One transient failure must not sign the socket out for good: try once more.
          return new Promise(function (r) { setTimeout(r, 750); }).then(function () { return auth.getToken({ forceRefresh: true }); });
        });
      }, function (ok) { rec.confirmed = !!ok; wake(); });
      return rec.ready();
    };
    if (authOf) authOf.set(client, rec);
    if (!auth) return rec;
    var session = null, ended = false;
    var stop = auth.onChange(function (st) {
      if (ended) return;
      if (st.sessionId === session) { if (!rec.known) { rec.known = true; wake(); } return; }
      if (session !== null) { // was signed in: this socket must not be reused
        ended = true;
        if (typeof stop === "function") stop();
        client.close();
        if (onEnded) onEnded(client);
        return;
      }
      session = st.sessionId;
      rec.known = true;
      rec.signedIn = !!st.signedIn;
      if (st.signedIn) rec.arm(); else wake();
    });
    return rec;
  }

  // Which backend to talk to: window.RIVET_CONVEX_URL if set (pages on this machine, and tests);
  // otherwise the hosting site's /api/config, i.e. the CONVEX_URL setting in Vercel. A hosted page
  // never falls back to a backend on the visitor's own machine (it would send their sign-in token
  // there) and accepts only an https *.convex.cloud URL; anything else is an error, not a guess.
  var CONVEX_CLOUD_URL = /^https:\/\/[a-z0-9-]+\.convex\.cloud$/;
  function backendUrl() {
    if (root.RIVET_CONVEX_URL) return Promise.resolve(root.RIVET_CONVEX_URL);
    var loc = root.location || {};
    var hosted = /^https?:$/.test(loc.protocol || "") && !/^(localhost|127\.0\.0\.1)$/.test(loc.hostname || "");
    if (!hosted || typeof root.fetch !== "function") return Promise.resolve(DEFAULT_URL);
    return root.fetch("/api/config")
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) {
        if (c && typeof c.convexUrl === "string" && CONVEX_CLOUD_URL.test(c.convexUrl)) return c.convexUrl;
        throw new Error("This site's backend isn't configured.");
      });
  }

  function getClient() {
    if (injected) return Promise.resolve(injected);
    if (!clientPromise) {
      clientPromise = Promise.all([import(CONVEX_ESM), backendUrl()])
        .then(function (r) {
          var c = new r[0].ConvexClient(r[1]);
          var mine = clientPromise;
          authenticate(c, function () { if (clientPromise === mine) clientPromise = null; });
          return c;
        })
        .catch(function (e) { clientPromise = null; throw e; });
    }
    return clientPromise;
  }

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var e = new Error("timeout");
        e.name = "RivetTimeout";
        reject(e);
      }, TIMEOUT_MS);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  // Signed in (per Clerk) but refused as signed out, or signed in with no account row
  // or role yet: see authenticate() above and accountProblem() below.
  function call(kind, name, args) {
    return withTimeout(getClient().then(function (c) {
      var rec = authOf && authOf.get(c);
      if (!rec) return c[kind](name, args); // tests inject a bare client
      return rec.ready().then(function () {
        // Clerk has a session but Convex isn't using it (refused or dropped): send it again.
        return rec.signedIn && rec.confirmed === false ? rec.arm() : rec;
      }).then(function () {
        return c[kind](name, args);
      }).catch(function (err) {
        if (!rec.signedIn) throw err;
        var p = authProblem(err);
        if (p === "signIn") {
          return rec.arm().then(function () { return c[kind](name, args); }).catch(function (e2) {
            if (authProblem(e2) === "signIn") e2.rivetSignedIn = true; // Clerk says signed in: don't tell them to sign in
            throw e2;
          });
        }
        if (p === "noAccount" && name !== "users:ensureAccount") return healAccount(c, kind, name, args, err);
        throw err;
      });
    }));
  }

  // "Finish setting up your account first": signed in, but this backend has no account
  // row (e.g. the Clerk account predates the backend) or no role yet. Create the row
  // (users:ensureAccount is idempotent); if a role is still missing, the page must ask
  // for one: the error is marked so friendlyError/needsRole can say so.
  function healAccount(c, kind, name, args, original) {
    return c.mutation("users:ensureAccount", {}).then(function (account) {
      if (account && account.role) return c[kind](name, args);
      original.rivetNeedsRole = true;
      throw original;
    });
  }
  function needsRole(err) { return !!err && (err.rivetNeedsRole === true || authProblem(err) === "noAccount"); }

  // Each resolves only after Convex has confirmed; rejections carry err.data when
  // the backend refused the input.
  function createRequest(args) { return call("mutation", "requests:create", args); }
  function updateIntake(id, args) {
    return call("mutation", "requests:updateIntake", Object.assign({ id: id }, args));
  }
  function saveFollowUps(id, followUps) {
    return call("mutation", "requests:saveFollowUps",
      { id: id, answers: followUps.answers, complete: followUps.complete });
  }
  function listRobots() { return call("query", "robots:search", {}); }
  // AI: status reads are free; generateSpec starts a paid call (backend refuses without a key).
  function aiStatus() { return call("query", "agent:aiStatus", {}); }
  function specStatus(id) { return call("query", "agent:specStatus", { requestId: id }); }
  function generateSpec(id) { return call("mutation", "agent:generateSpec", { requestId: id }); }
  // Robot finder: findRobots starts a paid run (fast read, maybe a web search, then
  // reasons); latestMatch is free and fills in over a few seconds, so poll it. The backend
  // refuses unless AI matching is switched on, the caller owns the request, and budget remains.
  function findRobots(id) { return call("mutation", "agent:findRobots", { requestId: id }); }
  function latestMatch(id) { return call("query", "agent:latestMatch", { requestId: id }); }
  function setTaskCost(id, annualTaskCost) {
    return call("mutation", "agent:setTaskCost", { requestId: id, annualTaskCost: annualTaskCost });
  }
  // Workflow breakdown: planWorkflow is one paid run (split the job into steps, search the biggest
  // robot-ready ones); latestWorkflow is free, poll it. Sliders and the labor cost re-rank in code
  // (free); checkStep is a paid search for one step that wasn't searched up front.
  function planWorkflow(id) { return call("mutation", "agent:planWorkflow", { requestId: id }); }
  function latestWorkflow(id) { return call("query", "agent:latestWorkflow", { requestId: id }); }
  function setStepShare(id, step, sharePct) {
    return call("mutation", "agent:setStepShare", { requestId: id, step: step, sharePct: sharePct });
  }
  function setWorkflowLabor(id, laborCost) {
    return call("mutation", "agent:setWorkflowLabor", { requestId: id, laborCost: laborCost });
  }
  function checkStep(id, step) { return call("mutation", "agent:checkStep", { requestId: id, step: step }); }
  // What the video analysis saw, saved on the request so the job breakdown uses it (null clears).
  function setVideoNotes(id, notes) { return call("mutation", "requests:setVideoNotes", { id: id, notes: notes }); }
  // Bounties other businesses posted for the same tasks, pooled (free).
  function pooledDemand(id, taskKeys) { return call("query", "bounties:pooledDemand", { requestId: id, taskKeys: taskKeys }); }
  function getDraft(id) { return call("query", "requests:getDraft", { id: id }); }
  function listMyRequests(limit) { return call("query", "requests:listMine", { limit: limit || 20 }); }
  function claimLegacyDraft(id, token) { return call("mutation", "requests:claimLegacyDraft", { id: id, clientToken: token }); }
  function postBounty(id, bounty) {
    return call("mutation", "bounties:post", Object.assign({ requestId: id }, bounty));
  }
  function getMyBounties(id) { return call("query", "bounties:getMine", { requestId: id }); }
  function listPostedBounties(limit) { return call("query", "bounties:listPosted", { limit: limit || 50 }); }
  // Live Developer board: onData(rows) runs now and again whenever a bounty is
  // posted or edited; onError(err) if the account may not read it. Returns stop().
  function watchPostedBounties(onData, onError, limit) {
    var stopped = false, unsubscribe = null;
    getClient().then(function (c) {
      var rec = authOf && authOf.get(c);
      return rec ? rec.ready().then(function () { return c; }) : c;
    }).then(function (c) {
      if (stopped) return;
      unsubscribe = c.onUpdate("bounties:listPosted", { limit: limit || 50 }, onData, onError);
    }, function (e) { if (!stopped && onError) onError(e); });
    return function () { stopped = true; if (unsubscribe) unsubscribe(); };
  }

  // ---- accounts -------------------------------------------------------------------
  function me() { return call("query", "users:me", {}); }
  function ensureAccount() { return call("mutation", "users:ensureAccount", {}); }
  // role: "client" | "developer". extra: { name, organization, inviteCode } (optional).
  function chooseRole(role, extra) {
    var args = { role: role };
    ["name", "organization", "inviteCode"].forEach(function (k) {
      var v = extra && String(extra[k] || "").trim();
      if (v) args[k] = v;
    });
    return call("mutation", "users:chooseRole", args);
  }
  function redeemInvite(code) { return call("mutation", "users:redeemDeveloperInvite", { code: String(code || "").trim() }); }
  // Where a signed-in account belongs (page name in pages/), from Convex's answer only.
  function homeFor(account) {
    if (!account || !account.role) return "signup";
    return account.role === "developer" ? "engineers" : "find-solution";
  }

  // ---- ids and persistence --------------------------------------------------------
  function newClientToken() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    var a = new Uint8Array(16);
    root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  // localStorage can throw (private mode, blocked storage): never let that break the page.
  // Returns {id: "..."} or null.
  function loadCurrent() {
    try {
      LEGACY_KEYS.forEach(function (k) { root.localStorage.removeItem(k); });
      var d = JSON.parse(root.localStorage.getItem(CURRENT_KEY) || "null");
      return d && typeof d.id === "string" ? { id: d.id } : null;
    } catch (e) { return null; }
  }
  function saveCurrent(id) {
    try { root.localStorage.setItem(CURRENT_KEY, JSON.stringify({ id: id })); } catch (e) { /* ignore */ }
  }
  function clearCurrent() { try { root.localStorage.removeItem(CURRENT_KEY); } catch (e) { /* ignore */ } }
  // A pre-accounts draft this browser still remembers, to claim once.
  function loadLegacyDraft() {
    try {
      var d = JSON.parse(root.localStorage.getItem(DRAFT_KEY) || "null");
      return d && typeof d.id === "string" && typeof d.token === "string" ? d : null;
    } catch (e) { return null; }
  }
  function clearLegacyDraft() { try { root.localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }

  root.RivetApi = {
    intakeToRequest: intakeToRequest,
    requestToIntake: requestToIntake,
    followUpsFromState: followUpsFromState,
    followUpsToState: followUpsToState,
    precheck: precheck,
    friendlyError: friendlyError,
    isDraftMissing: isDraftMissing,
    authProblem: authProblem,
    needsRole: needsRole,
    createRequest: createRequest,
    updateIntake: updateIntake,
    saveFollowUps: saveFollowUps,
    getDraft: getDraft,
    listMyRequests: listMyRequests,
    claimLegacyDraft: claimLegacyDraft,
    postBounty: postBounty,
    getMyBounties: getMyBounties,
    listPostedBounties: listPostedBounties,
    watchPostedBounties: watchPostedBounties,
    me: me,
    ensureAccount: ensureAccount,
    chooseRole: chooseRole,
    redeemInvite: redeemInvite,
    homeFor: homeFor,
    toBoardBounty: toBoardBounty,
    robotsToProducts: robotsToProducts,
    listRobots: listRobots,
    aiStatus: aiStatus,
    specStatus: specStatus,
    generateSpec: generateSpec,
    findRobots: findRobots,
    latestMatch: latestMatch,
    setTaskCost: setTaskCost,
    planWorkflow: planWorkflow,
    latestWorkflow: latestWorkflow,
    setStepShare: setStepShare,
    setWorkflowLabor: setWorkflowLabor,
    checkStep: checkStep,
    pooledDemand: pooledDemand,
    setVideoNotes: setVideoNotes,
    bountyToState: bountyToState,
    newClientToken: newClientToken,
    loadCurrent: loadCurrent,
    saveCurrent: saveCurrent,
    clearCurrent: clearCurrent,
    loadLegacyDraft: loadLegacyDraft,
    clearLegacyDraft: clearLegacyDraft,
    backend: BACKEND,
    currentKey: CURRENT_KEY,
    draftKey: DRAFT_KEY,
    _setClient: function (c) { injected = c; }, // tests only
    _authenticate: authenticate, // tests only
    _backendUrl: backendUrl, // tests only
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

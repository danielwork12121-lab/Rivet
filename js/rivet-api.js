// Rivet frontend <-> Convex glue. Classic script (no import/export) so it works
// from file:// as well as http://. Exposes `RivetApi` on the global object.
//
// Backend URL: `window.RIVET_CONVEX_URL` if set, else what /api/config returns
// (CONVEX_URL in Vercel), else the local dev deployment. Fictional demo data only: there are no
// accounts. A draft is protected only by its client token, kept in localStorage.
(function (root) {
  "use strict";

  var CONVEX_ESM = "https://esm.sh/convex@1.48.0/browser"; // pinned, matches package.json
  var DEFAULT_URL = "http://127.0.0.1:3210";
  var DRAFT_KEY = "rivet.intake.draft"; // {"id": "...", "token": "..."}
  var LEGACY_KEY = "rivet.intake.requestId"; // id only; unusable now that reads need the token
  var TIMEOUT_MS = 15000;
  var DRAFT_NOT_FOUND = "Draft not found"; // backend error text for unknown id or wrong token

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

  function friendlyError(err) {
    if (isDraftMissing(err)) return "Your saved request could not be found. Press the button again to save it as a new request.";
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
  var injected = null;
  var clientPromise = null;

  // Asks the hosting site which backend to use; any failure (file://, a local
  // static server with no /api) means the local dev deployment.
  function backendUrl() {
    if (root.RIVET_CONVEX_URL) return Promise.resolve(root.RIVET_CONVEX_URL);
    if (typeof fetch !== "function" || !/^https?:$/.test((root.location || {}).protocol || "")) {
      return Promise.resolve(DEFAULT_URL);
    }
    return fetch("/api/config")
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) { return (c && c.convexUrl) || DEFAULT_URL; })
      .catch(function () { return DEFAULT_URL; });
  }

  function getClient() {
    if (injected) return Promise.resolve(injected);
    if (!clientPromise) {
      clientPromise = Promise.all([import(CONVEX_ESM), backendUrl()])
        .then(function (r) { return new r[0].ConvexHttpClient(r[1]); })
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

  function call(kind, name, args) {
    return withTimeout(getClient().then(function (c) { return c[kind](name, args); }));
  }

  // Each resolves only after Convex has confirmed; rejections carry err.data when
  // the backend refused the input.
  function createRequest(args) { return call("mutation", "requests:create", args); }
  function updateIntake(id, token, args) {
    return call("mutation", "requests:updateIntake", Object.assign({ id: id, clientToken: token }, args));
  }
  function saveFollowUps(id, token, followUps) {
    return call("mutation", "requests:saveFollowUps",
      { id: id, clientToken: token, answers: followUps.answers, complete: followUps.complete });
  }
  function listRobots() { return call("query", "robots:search", {}); }
  // AI: status reads are free; generateSpec starts a paid call (backend refuses without a key).
  function aiStatus() { return call("query", "agent:aiStatus", {}); }
  function specStatus(id, token) { return call("query", "agent:specStatus", { requestId: id, clientToken: token }); }
  function generateSpec(id, token) { return call("mutation", "agent:generateSpec", { requestId: id, clientToken: token }); }
  // Robot finder: findRobots starts a paid run (fast read, maybe a web search, then
  // reasons); latestMatch is free and fills in over a few seconds, so poll it.
  function findRobots(id, token) { return call("mutation", "agent:findRobots", { requestId: id, clientToken: token }); }
  function latestMatch(id, token) { return call("query", "agent:latestMatch", { requestId: id, clientToken: token }); }
  function setTaskCost(id, token, annualTaskCost) {
    return call("mutation", "agent:setTaskCost", { requestId: id, clientToken: token, annualTaskCost: annualTaskCost });
  }
  function getDraft(id, token) { return call("query", "requests:getDraft", { id: id, clientToken: token }); }
  function postBounty(id, token, bounty) {
    return call("mutation", "bounties:post", Object.assign({ requestId: id, clientToken: token }, bounty));
  }
  function getMyBounties(id, token) { return call("query", "bounties:getMine", { requestId: id, clientToken: token }); }
  function listPostedBounties(limit) { return call("query", "bounties:listPosted", { limit: limit || 50 }); }

  // ---- ids and persistence --------------------------------------------------------
  function newClientToken() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    var a = new Uint8Array(16);
    root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  // localStorage can throw (private mode, blocked storage): never let that break the page.
  function loadDraft() {
    try {
      root.localStorage.removeItem(LEGACY_KEY);
      var d = JSON.parse(root.localStorage.getItem(DRAFT_KEY) || "null");
      return d && typeof d.id === "string" && typeof d.token === "string" ? d : null;
    } catch (e) { return null; }
  }
  function saveDraft(id, token) {
    try { root.localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: id, token: token })); } catch (e) { /* ignore */ }
  }
  function clearDraft() { try { root.localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }

  root.RivetApi = {
    intakeToRequest: intakeToRequest,
    requestToIntake: requestToIntake,
    followUpsFromState: followUpsFromState,
    followUpsToState: followUpsToState,
    precheck: precheck,
    friendlyError: friendlyError,
    isDraftMissing: isDraftMissing,
    createRequest: createRequest,
    updateIntake: updateIntake,
    saveFollowUps: saveFollowUps,
    getDraft: getDraft,
    postBounty: postBounty,
    getMyBounties: getMyBounties,
    listPostedBounties: listPostedBounties,
    toBoardBounty: toBoardBounty,
    robotsToProducts: robotsToProducts,
    listRobots: listRobots,
    aiStatus: aiStatus,
    specStatus: specStatus,
    generateSpec: generateSpec,
    findRobots: findRobots,
    latestMatch: latestMatch,
    setTaskCost: setTaskCost,
    bountyToState: bountyToState,
    newClientToken: newClientToken,
    loadDraft: loadDraft,
    saveDraft: saveDraft,
    clearDraft: clearDraft,
    _setClient: function (c) { injected = c; }, // tests only
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

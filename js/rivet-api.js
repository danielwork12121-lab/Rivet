// Rivet frontend <-> Convex glue. Classic script (no import/export) so it works
// from file:// as well as http://. Exposes `RivetApi` on the global object.
//
// Backend URL: set `window.RIVET_CONVEX_URL` before this script to override.
// The default is the local dev deployment. Fictional demo data only: the backend
// has no authentication yet, so anyone who can reach the URL can read and write.
(function (root) {
  "use strict";

  var CONVEX_ESM = "https://esm.sh/convex@1.48.0/browser"; // pinned, matches package.json
  var DEFAULT_URL = "http://127.0.0.1:3210";
  var STORAGE_KEY = "rivet.intake.requestId";
  var TIMEOUT_MS = 15000;

  var BUSINESS_LABELS = { lawn: "Lawn care", pest: "Pest control" };

  // ---- mapping: intake state -> requests:create args ------------------------------
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

  // Stored request -> partial page state, or null if it has no usable profile.
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

  // Cheap client-side check so obvious mistakes don't cost a round trip.
  // The backend re-validates everything; this is only for friendlier messages.
  function precheck(S) {
    if (!String(S.name || "").trim()) return "Please enter your company name.";
    if (!String(S.describe || "").trim()) return "Please describe a normal week before continuing.";
    return null;
  }

  // ---- errors ---------------------------------------------------------------------
  function friendlyError(err) {
    if (err && typeof err.data === "string") return err.data; // ConvexError from validation
    if (err && err.name === "RivetTimeout") {
      return "The server took too long to respond. Your request may or may not have been saved. Press Continue again; it will not create a duplicate.";
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

  function getClient() {
    if (injected) return Promise.resolve(injected);
    if (!clientPromise) {
      var url = root.RIVET_CONVEX_URL || DEFAULT_URL;
      clientPromise = import(CONVEX_ESM)
        .then(function (m) { return new m.ConvexHttpClient(url); })
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

  // Resolves with the request id only after Convex has confirmed the write.
  function createRequest(args) {
    return withTimeout(getClient().then(function (c) { return c.mutation("requests:create", args); }));
  }

  // Resolves with the stored request, or null if no such id exists.
  function getRequest(id) {
    return withTimeout(getClient().then(function (c) { return c.query("requests:get", { id: id }); }));
  }

  // ---- ids and persistence --------------------------------------------------------
  function newClientToken() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    var a = new Uint8Array(16);
    root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  // localStorage can throw (private mode, blocked storage): never let that break the page.
  function loadSavedId() { try { return root.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } }
  function saveId(id) { try { root.localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* ignore */ } }
  function clearSavedId() { try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } }

  root.RivetApi = {
    intakeToRequest: intakeToRequest,
    requestToIntake: requestToIntake,
    precheck: precheck,
    friendlyError: friendlyError,
    createRequest: createRequest,
    getRequest: getRequest,
    newClientToken: newClientToken,
    loadSavedId: loadSavedId,
    saveId: saveId,
    clearSavedId: clearSavedId,
    _setClient: function (c) { injected = c; }, // tests only
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

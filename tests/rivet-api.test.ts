import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// rivet-api.js is a classic browser script that attaches RivetApi to globalThis.
// @ts-expect-error plain JS, no types
beforeAll(async () => { await import("../js/rivet-api.js"); });

const api = () => (globalThis as any).RivetApi;

const lawn = {
  type: "lawn", name: "  Green Acres Lawn Co. ", describe: "We mow lawns.",
  crews: 3, perCrew: 2, wage: 24, region: "West", visibility: "shared",
};
const pest = { ...lawn, type: "pest", name: "Valley Shield Pest Control", crews: 1, visibility: "anon" };

describe("intakeToRequest", () => {
  it("maps lawn intake to create args, deriving title and environment", () => {
    expect(api().intakeToRequest(lawn, "tok-12345678")).toEqual({
      title: "Green Acres Lawn Co. — Lawn care automation request",
      description: "We mow lawns.",
      environment: "Lawn care operation, West region, 3 crews of 2 people.",
      constraints: [],
      profile: {
        companyName: "Green Acres Lawn Co.", businessType: "lawn", region: "West",
        crewCount: 3, peoplePerCrew: 2, hourlyLaborCost: 24, visibility: "shared",
      },
      clientToken: "tok-12345678",
    });
  });

  it("omits peoplePerCrew for pest control and maps anon -> anonymous", () => {
    const a = api().intakeToRequest(pest);
    expect(a.profile).not.toHaveProperty("peoplePerCrew");
    expect(a.profile.visibility).toBe("anonymous");
    expect(a.environment).toBe("Pest control operation, West region, 1 tech.");
    expect(a).not.toHaveProperty("clientToken");
  });

  it("keeps the derived title within the backend's 120-character limit", () => {
    const a = api().intakeToRequest({ ...lawn, name: "x".repeat(300) });
    expect(a.title.length).toBeLessThanOrEqual(120);
  });

  it("is deterministic, so unchanged forms have equal fingerprints", () => {
    expect(JSON.stringify(api().intakeToRequest(lawn))).toBe(JSON.stringify(api().intakeToRequest({ ...lawn })));
  });
});

describe("requestToIntake (refresh path)", () => {
  it("round-trips the intake fields", () => {
    const args = api().intakeToRequest(lawn);
    const doc = { ...args, profile: { ...args.profile, companyName: "Green Acres Lawn Co." } };
    expect(api().requestToIntake(doc)).toEqual({
      type: "lawn", name: "Green Acres Lawn Co.", describe: "We mow lawns.",
      crews: 3, perCrew: 2, wage: 24, region: "West", visibility: "shared",
    });
  });

  it("returns null for requests without a profile or for null", () => {
    expect(api().requestToIntake({ description: "d" })).toBeNull();
    expect(api().requestToIntake(null)).toBeNull();
  });

  it("returns markup unchanged (escaping is the renderer's job)", () => {
    const doc = { description: "<b>x</b>", profile: { companyName: "<script>1</script>", businessType: "lawn", region: "West", crewCount: 1, hourlyLaborCost: 1, visibility: "shared" } };
    const out = api().requestToIntake(doc);
    expect(out.describe).toBe("<b>x</b>");
    expect(out.name).toBe("<script>1</script>");
  });
});

describe("precheck", () => {
  it("flags an empty or whitespace description", () => {
    expect(api().precheck({ ...lawn, describe: "   " })).toMatch(/describe a normal week/);
  });
  it("flags an empty company name", () => {
    expect(api().precheck({ ...lawn, name: " " })).toMatch(/company name/);
  });
  it("passes a complete form", () => { expect(api().precheck(lawn)).toBeNull(); });
});

describe("friendlyError", () => {
  it("shows ConvexError data verbatim", () => {
    expect(api().friendlyError({ data: "title must not be empty" })).toBe("title must not be empty");
  });
  it("describes network failures as a connection problem", () => {
    expect(api().friendlyError(new TypeError("Failed to fetch"))).toMatch(/Can't reach the Rivet server/);
  });
  it("describes server-side rejections without leaking internals", () => {
    const m = api().friendlyError(new Error("[Request ID: abc] Server Error Uncaught ..."));
    expect(m).toMatch(/server rejected/);
    expect(m).not.toMatch(/abc/);
  });
  it("tells the user a timeout is safe to retry", () => {
    const e = new Error("timeout"); e.name = "RivetTimeout";
    expect(api().friendlyError(e)).toMatch(/will not create a duplicate/);
  });
});

describe("network calls with a fake client", () => {
  beforeEach(() => api()._setClient(null));

  it("resolves with the id only after the mutation resolves", async () => {
    let release!: (v: string) => void;
    const mutation = vi.fn(() => new Promise<string>((r) => (release = r)));
    api()._setClient({ mutation, query: vi.fn() });
    let done = false;
    const p = api().createRequest({ a: 1 }).then((id: string) => { done = true; return id; });
    await Promise.resolve(); await Promise.resolve();
    expect(done).toBe(false); // nothing confirmed yet
    release("id123");
    expect(await p).toBe("id123");
    expect(mutation).toHaveBeenCalledWith("requests:create", { a: 1 });
  });

  it("propagates a rejected mutation (so the UI can show an error, not success)", async () => {
    api()._setClient({ mutation: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), query: vi.fn() });
    await expect(api().createRequest({})).rejects.toThrow("Failed to fetch");
  });

  it("draft calls send only the id: ownership comes from the signed-in account", async () => {
    const mutation = vi.fn().mockResolvedValue("id1");
    const query = vi.fn().mockResolvedValue({ _id: "id1" });
    api()._setClient({ mutation, query });
    await api().getDraft("id1");
    expect(query).toHaveBeenCalledWith("requests:getDraft", { id: "id1" });
    await api().updateIntake("id1", { title: "t" });
    expect(mutation).toHaveBeenCalledWith("requests:updateIntake", { id: "id1", title: "t" });
    await api().saveFollowUps("id1", { answers: [], complete: false });
    expect(mutation).toHaveBeenCalledWith("requests:saveFollowUps", { id: "id1", answers: [], complete: false });
    await api().listMyRequests(1);
    expect(query).toHaveBeenCalledWith("requests:listMine", { limit: 1 });
    await api().claimLegacyDraft("old1", "tok-12345678");
    expect(mutation).toHaveBeenCalledWith("requests:claimLegacyDraft", { id: "old1", clientToken: "tok-12345678" });
  });

  it("account calls: me, ensureAccount, chooseRole (blank extras dropped), redeemInvite", async () => {
    const mutation = vi.fn().mockResolvedValue({});
    const query = vi.fn().mockResolvedValue({ signedIn: false, account: null });
    api()._setClient({ mutation, query });
    await api().me();
    expect(query).toHaveBeenCalledWith("users:me", {});
    await api().ensureAccount();
    expect(mutation).toHaveBeenCalledWith("users:ensureAccount", {});
    await api().chooseRole("developer", { name: " Ana ", organization: "", inviteCode: " rivet-dev-abc " });
    expect(mutation).toHaveBeenCalledWith("users:chooseRole", { role: "developer", name: "Ana", inviteCode: "rivet-dev-abc" });
    await api().redeemInvite(" code-1 ");
    expect(mutation).toHaveBeenCalledWith("users:redeemDeveloperInvite", { code: "code-1" });
  });

  it("homeFor routes by the role Convex returned", () => {
    expect(api().homeFor(null)).toBe("signup");
    expect(api().homeFor({ role: null })).toBe("signup");
    expect(api().homeFor({ role: "client" })).toBe("find-solution");
    expect(api().homeFor({ role: "developer", developerStatus: "pending" })).toBe("engineers");
  });

  it("authProblem recognises the backend's access errors", () => {
    expect(api().authProblem({ data: "Please sign in to continue." })).toBe("signIn");
    expect(api().authProblem({ data: "This needs a Client account." })).toBe("clientOnly");
    expect(api().authProblem({ data: "This needs an approved Developer account." })).toBe("developerOnly");
    expect(api().authProblem({ data: "Finish setting up your account first." })).toBe("noAccount");
    expect(api().authProblem({ data: "title must not be empty" })).toBeNull();
    expect(api().friendlyError({ data: "This needs a Client account." })).toBe("This needs a Client account.");
  });

  it("watchPostedBounties subscribes and returns a working stop()", async () => {
    const stop = vi.fn();
    const onUpdate = vi.fn().mockReturnValue(stop);
    api()._setClient({ onUpdate, query: vi.fn(), mutation: vi.fn() });
    const onData = vi.fn(), onError = vi.fn();
    const off = api().watchPostedBounties(onData, onError, 10);
    await Promise.resolve(); await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledWith("bounties:listPosted", { limit: 10 }, onData, onError);
    off();
    expect(stop).toHaveBeenCalled();
    api()._setClient(null);
  });

  it("never calls the legacy public requests:get / requests:list", async () => {
    const query = vi.fn().mockResolvedValue(null);
    api()._setClient({ mutation: vi.fn().mockResolvedValue("x"), query });
    expect(api()).not.toHaveProperty("getRequest");
    await api().getDraft("a", "b");
    expect(query.mock.calls.map((c) => c[0])).toEqual(["requests:getDraft"]);
  });
});

describe("draft errors", () => {
  it("recognises the backend's draft-not-found error and explains it", () => {
    const e = { data: "Draft not found" };
    expect(api().isDraftMissing(e)).toBe(true);
    expect(api().isDraftMissing({ data: "title must not be empty" })).toBe(false);
    expect(api().isDraftMissing(new TypeError("Failed to fetch"))).toBe(false);
    expect(api().friendlyError(e)).toMatch(/could not be found/);
  });
});

describe("follow-up mapping", () => {
  const QUESTIONS = [
    { key: "slope", q: "Slopes?", opts: [["Very few", 15], ["Some", 20], ["A lot of them", 28]] },
    { key: "obstacles", q: "Obstacles?", opts: [["Mostly open", 1], ["Mixed", .85], ["Lots of obstacles", .7]] },
    { key: "weeks", q: "Weeks?", opts: [["About 26", 26], ["About 32", 32], ["Most of the year (45)", 45]] },
  ];
  const defaults = { slope: 20, obstacles: .85, weeks: 32 };

  it("never sends untouched defaults: nothing answered -> nothing saved", () => {
    expect(api().followUpsFromState({ answers: defaults, answered: 0 }, QUESTIONS)).toEqual({ answers: [], complete: false });
  });

  it("sends only the answered prefix, with raw label, key and assumption separate", () => {
    const f = api().followUpsFromState({ answers: { ...defaults, slope: 28 }, answered: 1 }, QUESTIONS);
    expect(f).toEqual({
      answers: [{ key: "slope", question: "Slopes?", answerLabel: "A lot of them", assumption: { value: 28, unit: "degrees" } }],
      complete: false,
    });
  });

  it("gives the obstacle multiplier no unit and marks a full set complete", () => {
    const f = api().followUpsFromState({ answers: { slope: 15, obstacles: .7, weeks: 45 }, answered: 3 }, QUESTIONS);
    expect(f.complete).toBe(true);
    expect(f.answers[1]).toEqual({ key: "obstacles", question: "Obstacles?", answerLabel: "Lots of obstacles", assumption: { value: .7 } });
    expect(f.answers[2].assumption).toEqual({ value: 45, unit: "weeks per year" });
  });

  it("restores saved answers by raw label, in question order", () => {
    const saved = [
      { key: "weeks", question: "Weeks?", answerLabel: "About 26", assumption: { value: 26, unit: "weeks per year" } },
      { key: "slope", question: "Slopes?", answerLabel: "Some", assumption: { value: 20, unit: "degrees" } },
      { key: "obstacles", question: "Obstacles?", answerLabel: "Mixed", assumption: { value: .85 } },
    ];
    expect(api().followUpsToState(saved, QUESTIONS)).toEqual({ answers: { slope: 20, obstacles: .85, weeks: 26 }, answered: 3 });
  });

  it("stops restoring at the first unknown label or gap, and ignores unknown keys", () => {
    const saved = [
      { key: "slope", question: "Slopes?", answerLabel: "Some" },
      { key: "obstacles", question: "Obstacles?", answerLabel: "Renamed option" },
      { key: "weeks", question: "Weeks?", answerLabel: "About 26" },
      { key: "colour", question: "?", answerLabel: "Blue" },
    ];
    expect(api().followUpsToState(saved, QUESTIONS)).toEqual({ answers: { slope: 20 }, answered: 1 });
    expect(api().followUpsToState(undefined, QUESTIONS)).toEqual({ answers: {}, answered: 0 });
  });

  it("round-trips: save -> restore -> save gives the same payload", () => {
    const state = { answers: { slope: 28, obstacles: 1, weeks: 32 }, answered: 3 };
    const saved = api().followUpsFromState(state, QUESTIONS);
    const restored = api().followUpsToState(saved.answers, QUESTIONS);
    expect(api().followUpsFromState({ answers: { ...defaults, ...restored.answers }, answered: restored.answered }, QUESTIONS)).toEqual(saved);
  });
});

describe("bounty mapping", () => {
  const TASK_SKILLS = { mow: ["Outdoor wheeled bases", "Slope traction"] };
  const CATEGORY = { mow: "Mowing" };
  const pub = {
    _id: "b1", _creationTime: 1, title: "Mower for <b>slopes</b>", taskKey: "mow", industry: "Lawn care",
    region: "West", specLines: ["Works on slopes up to 28°", "<img src=x>"], goal: 150000, pledged: 4500,
  };

  it("maps a public bounty to a board card, marked as a saved submission, text untouched", () => {
    expect(api().toBoardBounty(pub, TASK_SKILLS, CATEGORY)).toEqual({
      id: "saved-b1", saved: true, title: "Mower for <b>slopes</b>", industry: "Lawn care", cat: "Mowing",
      region: "West", pledged: 4500, goal: 150000, backers: 1, closes: "\u2014",
      skills: ["Outdoor wheeled bases", "Slope traction"], specs: ["Works on slopes up to 28°", "<img src=x>"],
    });
  });

  it("drops bounties for tasks the page doesn't know", () => {
    expect(api().toBoardBounty({ ...pub, taskKey: "weld" }, TASK_SKILLS, CATEGORY)).toBeNull();
  });

  it("restores the newest posted bounty whose task fits the business type", () => {
    const posted = [
      { _id: "p2", taskKey: "crawl", gaps: [], pledgePercent: 20 },
      { _id: "p1", taskKey: "mow", gaps: ["Too expensive"], note: "Fits in the trailer", pledgePercent: 35, pledged: 5200 },
    ];
    expect(api().bountyToState(posted, ["mow", "spray", "trim"])).toEqual({
      id: "p1", bounty: { taskId: "mow", product: null }, gaps: ["Too expensive"], gapNote: "Fits in the trailer", pledgePct: 35, pledged: 5200,
    });
    expect(api().bountyToState([], ["mow"])).toBeNull();
  });

  it("bounty calls send the draft id only", async () => {
    const mutation = vi.fn().mockResolvedValue("b1");
    const query = vi.fn().mockResolvedValue([]);
    api()._setClient({ mutation, query });
    await api().postBounty("r1", { taskKey: "mow" });
    expect(mutation).toHaveBeenCalledWith("bounties:post", { requestId: "r1", taskKey: "mow" });
    await api().getMyBounties("r1");
    expect(query).toHaveBeenCalledWith("bounties:getMine", { requestId: "r1" });
    await api().listPostedBounties();
    expect(query).toHaveBeenCalledWith("bounties:listPosted", { limit: 50 });
    api()._setClient(null);
  });
});

describe("draft storage", () => {
  const memoryStorage = () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    return store;
  };

  it("remembers which request is being edited", () => {
    memoryStorage();
    expect(api().loadCurrent()).toBeNull();
    api().saveCurrent("abc");
    expect(api().loadCurrent()).toEqual({ id: "abc" });
    api().clearCurrent();
    expect(api().loadCurrent()).toBeNull();
  });

  it("keeps one choice per backend and never stores a token for it", () => {
    const store = memoryStorage();
    api().saveCurrent("abc");
    expect(api().currentKey).toBe("rivet.intake.current.local");
    expect(JSON.parse(store.get("rivet.intake.current.local")!)).toEqual({ id: "abc" });
  });

  it("reads a pre-accounts draft (id + token) once, for claiming, then forgets it", () => {
    const store = memoryStorage();
    expect(api().draftKey).toBe("rivet.intake.draft.local");
    store.set("rivet.intake.draft.local", JSON.stringify({ id: "old", token: "tok-12345678" }));
    expect(api().loadLegacyDraft()).toEqual({ id: "old", token: "tok-12345678" });
    api().clearLegacyDraft();
    expect(api().loadLegacyDraft()).toBeNull();
    store.set("rivet.intake.draft.local", JSON.stringify({ id: "x" }));
    expect(api().loadLegacyDraft()).toBeNull();
  });

  it("discards the legacy id-only key, the un-namespaced draft, and malformed values", () => {
    const store = memoryStorage();
    store.set("rivet.intake.requestId", "old-id");
    store.set("rivet.intake.draft", JSON.stringify({ id: "old", token: "old-token" }));
    expect(api().loadCurrent()).toBeNull();
    expect(store.has("rivet.intake.requestId")).toBe(false);
    expect(store.has("rivet.intake.draft")).toBe(false);
    store.set("rivet.intake.current.local", "{not json");
    expect(api().loadCurrent()).toBeNull();
    store.set("rivet.intake.current.local", JSON.stringify({ id: 5 }));
    expect(api().loadCurrent()).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    (globalThis as any).localStorage = new Proxy({}, { get() { throw new Error("blocked"); } });
    expect(() => { api().saveCurrent("x"); api().clearCurrent(); api().clearLegacyDraft(); }).not.toThrow();
    expect(api().loadCurrent()).toBeNull();
    expect(api().loadLegacyDraft()).toBeNull();
  });
});

describe("newClientToken", () => {
  it("is unique and satisfies the backend token format", () => {
    const a = api().newClientToken(), b = api().newClientToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
});

describe("backendUrl (hosted pages ask /api/config, never fall back to this machine)", () => {
  const g = globalThis as any;
  const at = (protocol: string, hostname: string) => vi.stubGlobal("location", { protocol, hostname });
  const config = (body: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })));
  let saved: unknown;
  beforeEach(() => { saved = g.RIVET_CONVEX_URL; delete g.RIVET_CONVEX_URL; });
  afterEach(() => { vi.unstubAllGlobals(); g.RIVET_CONVEX_URL = saved; });

  it("an injected URL wins and nothing is fetched", async () => {
    g.RIVET_CONVEX_URL = "http://127.0.0.1:1";
    config({});
    await expect(api()._backendUrl()).resolves.toBe("http://127.0.0.1:1");
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("on this machine, the local backend", async () => {
    at("http:", "localhost");
    config({});
    await expect(api()._backendUrl()).resolves.toBe("http://127.0.0.1:3210");
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("a hosted page uses the Convex Cloud URL from /api/config", async () => {
    at("https:", "rivet-rose.vercel.app");
    config({ convexUrl: "https://example-name-123.convex.cloud" });
    await expect(api()._backendUrl()).resolves.toBe("https://example-name-123.convex.cloud");
    expect(g.fetch).toHaveBeenCalledWith("/api/config");
  });

  it.each([
    ["missing", {}, true],
    ["not Convex Cloud", { convexUrl: "https://evil.example" }, true],
    ["local", { convexUrl: "http://127.0.0.1:3210" }, true],
    ["a failed request", { convexUrl: "https://x.convex.cloud" }, false],
  ])("a hosted page refuses a %s URL instead of falling back", async (_n, body, ok) => {
    at("https:", "rivet-rose.vercel.app");
    config(body, ok as boolean);
    await expect(api()._backendUrl()).rejects.toThrow(/backend isn't configured/);
  });
});

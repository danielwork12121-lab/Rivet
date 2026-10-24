import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("createRequest / getRequest with a fake client", () => {
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

  it("getRequest passes the id and returns null for unknown ids", async () => {
    const query = vi.fn().mockResolvedValue(null);
    api()._setClient({ mutation: vi.fn(), query });
    expect(await api().getRequest("abc")).toBeNull();
    expect(query).toHaveBeenCalledWith("requests:get", { id: "abc" });
  });
});

describe("storage helpers", () => {
  it("round-trips the saved id", () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(api().loadSavedId()).toBeNull();
    api().saveId("abc");
    expect(api().loadSavedId()).toBe("abc");
    api().clearSavedId();
    expect(api().loadSavedId()).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    (globalThis as any).localStorage = new Proxy({}, { get() { throw new Error("blocked"); } });
    expect(() => { api().saveId("x"); api().clearSavedId(); }).not.toThrow();
    expect(api().loadSavedId()).toBeNull();
  });
});

describe("newClientToken", () => {
  it("is unique and satisfies the backend token format", () => {
    const a = api().newClientToken(), b = api().newClientToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
});

// @vitest-environment node
// api/analyze-video.js (Vercel function) with fetch stubbed: no network, no Gemini cost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS, no types
import handler from "../api/analyze-video.js";

const CONVEX = "https://example-test.convex.cloud";
const GEMINI = "https://generativelanguage.googleapis.com/";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX3Rlc3QifQ.c2lnbmF0dXJl";
const FRAME = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD";
const ANALYSIS = { taskSummary: "Mowing a lawn.", environment: [], observedObjects: [], obstacles: [], repetitiveActions: [], requirements: [], followUpQuestions: [], robotCapabilitiesNeeded: [], frames: [] };

function call(opts: { method?: string; body?: unknown; ip?: string; auth?: string | null } = {}) {
  const res: any = {
    statusCode: 0, body: undefined, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  const req = {
    method: opts.method ?? "POST",
    headers: { "x-vercel-forwarded-for": opts.ip ?? "203.0.113.7", ...(opts.auth === null ? {} : { authorization: opts.auth ?? `Bearer ${TOKEN}` }) },
    body: "body" in opts ? opts.body : { frames: [FRAME, FRAME] },
  };
  return handler(req, res).then(() => res);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiOk = () => json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(ANALYSIS) }] } }] });

let fetchSpy: ReturnType<typeof vi.fn>;
const calls = (url: string) => fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(url));
function route({ budget = { status: "success", value: { ok: true } } as any, model = undefined as any } = {}) {
  fetchSpy = vi.fn(async (url: string) => {
    if (url.startsWith(CONVEX)) {
      if (budget instanceof Error) throw budget;
      return json(200, budget);
    }
    if (url.startsWith(GEMINI)) {
      if (model instanceof Error) throw model;
      return model ?? geminiOk();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => {
  vi.stubEnv("VIDEO_ENABLED", "true");
  vi.stubEnv("GEMINI_API_KEY", "gemini-key-not-real");
  vi.stubEnv("CONVEX_URL", CONVEX);
  vi.stubEnv("RIVET_SERVER_SECRET", "shared-secret-for-tests");
  route();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("api/analyze-video: switch and sign-in", () => {
  it("rejects non-POST without calling anything", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([["VIDEO_ENABLED", "false"], ["VIDEO_ENABLED", ""], ["GEMINI_API_KEY", ""], ["CONVEX_URL", ""], ["RIVET_SERVER_SECRET", ""]])(
    "is off (503, no calls) when %s=%j",
    async (name, value) => {
      vi.stubEnv(name, value);
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: "unavailable", message: "Video analysis isn't available right now." });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("is off by default (no VIDEO_ENABLED at all)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("GEMINI_API_KEY", "gemini-key-not-real");
    vi.stubEnv("CONVEX_URL", CONVEX);
    vi.stubEnv("RIVET_SERVER_SECRET", "shared-secret-for-tests");
    vi.stubEnv("VIDEO_ENABLED", "");
    expect((await call()).statusCode).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header (anonymous)", null],
    ["a non-Bearer scheme", `Basic ${TOKEN}`],
    ["a token that isn't a JWT", "Bearer not-a-jwt"],
  ])("refuses %s with 401 before calling Convex or Gemini", async (_n, auth) => {
    const res = await call({ auth });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["Convex rejects the token (expired, forged)", { status: "error", errorMessage: "Unauthenticated: Could not verify OIDC token claim" }, 401],
    ["the account isn't signed up", { status: "success", value: { ok: false, reason: "unauthenticated" } }, 401],
    ["signed in but no account set up", { status: "success", value: { ok: false, reason: "no_account" } }, 403],
    ["the account is a Developer", { status: "success", value: { ok: false, reason: "not_client" } }, 403],
  ])("%s: refused and Gemini is never called", async (_n, budget, status) => {
    route({ budget });
    const res = await call();
    expect(res.statusCode).toBe(status);
    expect(calls(GEMINI)).toHaveLength(0);
  });
});

describe("api/analyze-video: budget", () => {
  it("forwards the visitor's token and a hashed visitor key (never the IP) to aiBudget:reserveVideo", async () => {
    await call({ ip: "203.0.113.7, 10.0.0.1" });
    const [url, init] = calls(CONVEX)[0];
    expect(url).toBe(`${CONVEX}/api/mutation`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ path: "aiBudget:reserveVideo", args: { secret: "shared-secret-for-tests" } });
    expect(sent.args.clientKey).toMatch(/^[a-f0-9]{32}$/);
    expect(init.body).not.toContain("203.0.113.7");
  });

  it.each([["video_limit"], ["video_user_limit"], ["daily_limit"], ["user_limit"], ["client_limit"]])(
    "over budget (%s): 429 and Gemini is never called", async (reason) => {
      route({ budget: { status: "success", value: { ok: false, reason } } });
      const res = await call();
      expect(res.statusCode).toBe(429);
      expect(res.body.error).toBe("limit");
      expect(calls(GEMINI)).toHaveLength(0);
    });

  it.each([
    ["Convex unreachable", new Error("network down")],
    ["Convex refuses (wrong secret)", { status: "error", errorMessage: "forbidden" }],
  ])("%s: fails closed (503) and Gemini is never called", async (_n, budget) => {
    route({ budget });
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(calls(GEMINI)).toHaveLength(0);
  });
});

describe("api/analyze-video: request validation (spends no budget, calls no Gemini)", () => {
  const big = (n: number) => `data:image/jpeg;base64,${"A".repeat(n)}`;
  it.each([
    ["invalid JSON", { body: "{not json" }, 400],
    ["no body", { body: undefined }, 400],
    ["no frames", { body: { frames: [] } }, 400],
    ["frames not an array", { body: { frames: "nope" } }, 400],
    ["a non-string frame", { body: { frames: [FRAME, 42] } }, 400],
    ["too many frames", { body: { frames: Array(9).fill(FRAME) } }, 400],
    ["a non-image type", { body: { frames: ["data:text/html;base64,PGgxPmhpPC9oMT4="] } }, 400],
    ["an SVG (scriptable) image", { body: { frames: ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="] } }, 400],
    ["not a data URL", { body: { frames: ["https://example.com/a.jpg"] } }, 400],
    ["invalid base64 characters", { body: { frames: ["data:image/jpeg;base64,@@@not base64@@@"] } }, 400],
    ["one oversized frame", { body: { frames: [FRAME, big(600_100)] } }, 413],
    ["frames too large together", { body: { frames: Array(5).fill(big(550_000)) } }, 413],
  ])("rejects %s", async (_n, opts, status) => {
    const res = await call(opts as any);
    expect(res.statusCode).toBe(status);
    expect(calls(CONVEX)).toHaveLength(0);
    expect(calls(GEMINI)).toHaveLength(0);
  });

  it("accepts JPEG, PNG and WebP, and the largest allowed frame", async () => {
    const res = await call({ body: { frames: [FRAME, "data:image/png;base64,iVBORw0KGgo=", "data:image/webp;base64,UklGRg==", big(595_000)] } });
    expect(res.statusCode).toBe(200);
  });
});

describe("api/analyze-video: Gemini call", () => {
  it("returns the model's analysis in the original response shape", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ analysis: ANALYSIS });
  });

  it("sends every frame to Gemini with the key in a header, not the URL", async () => {
    await call({ body: { frames: [FRAME, FRAME, FRAME] } });
    const [url, init] = calls(GEMINI)[0];
    expect(url).not.toContain("key=");
    expect(url).not.toContain("gemini-key-not-real");
    expect(init.headers["x-goog-api-key"]).toBe("gemini-key-not-real");
    const sent = JSON.parse(init.body);
    expect(sent.contents[0].parts.filter((p: any) => p.inlineData)).toHaveLength(3);
    expect(sent.generationConfig.responseMimeType).toBe("application/json");
  });

  it("a Gemini error becomes a generic 502 without Gemini's text or the key", async () => {
    route({ model: json(400, { error: { message: "API key not valid: gemini-key-not-real SECRET-DETAIL" } }) });
    const res = await call();
    expect(res.statusCode).toBe(502);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("SECRET-DETAIL");
    expect(text).not.toContain("gemini-key-not-real");
    expect(res.body).not.toHaveProperty("detail");
  });

  it.each([
    ["an empty reply", json(200, { candidates: [] })],
    ["non-JSON output", json(200, { candidates: [{ content: { parts: [{ text: "not json" }] } }] })],
  ])("%s is reported as a failure", async (_n, model) => {
    route({ model });
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toHaveProperty("analysis");
  });

  it("a timeout is 504; any other failure is a generic 500", async () => {
    route({ model: Object.assign(new Error("aborted"), { name: "AbortError" }) });
    expect((await call()).statusCode).toBe(504);
    route({ model: new Error("socket hang up gemini-key-not-real") });
    const res = await call();
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("gemini-key-not-real");
  });
});

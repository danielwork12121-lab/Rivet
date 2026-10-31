// @vitest-environment node
// api/chat.js (Vercel function) with fetch stubbed: no network, no cost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS, no types
import handler from "../api/chat.js";

const CONVEX = "https://example-test.convex.cloud";
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

// Shaped like a Clerk session token. Its contents are never read here: /api/chat
// forwards it and Convex verifies it (stubbed below).
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX3Rlc3QifQ.c2lnbmF0dXJl";

function call(opts: { method?: string; body?: unknown; ip?: string; auth?: string | null } = {}) {
  const res: any = {
    statusCode: 0, body: undefined, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  const req = {
    method: opts.method ?? "POST",
    headers: {
      "x-vercel-forwarded-for": opts.ip ?? "203.0.113.7",
      ...(opts.auth === null ? {} : { authorization: opts.auth ?? `Bearer ${TOKEN}` }),
    },
    body: opts.body ?? { message: "We mow 40 fictional lawns a week.", mode: "opening" },
  };
  return handler(req, res).then(() => res);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchSpy: ReturnType<typeof vi.fn>;
const calls = (url: string) => fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(url));
function route({ budget = { status: "success", value: { ok: true } } as any, model = undefined as any } = {}) {
  fetchSpy = vi.fn(async (url: string) => {
    if (url.startsWith(CONVEX)) {
      if (budget instanceof Error) throw budget;
      return json(200, budget);
    }
    if (url === ANTHROPIC) {
      if (model instanceof Error) throw model;
      return model ?? json(200, { content: [{ type: "text", text: "Got it: mowing 40 lawns." }], stop_reason: "end_turn" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => {
  vi.stubEnv("CHAT_ENABLED", "true");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.stubEnv("CONVEX_URL", CONVEX);
  vi.stubEnv("RIVET_SERVER_SECRET", "shared-secret-for-tests");
  route();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("api/chat", () => {
  it("rejects non-POST without calling anything", async () => {
    const res = await call({ method: "GET" });
    expect(res.statusCode).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([["CHAT_ENABLED", "false"], ["CHAT_ENABLED", ""], ["ANTHROPIC_API_KEY", ""], ["CONVEX_URL", ""], ["RIVET_SERVER_SECRET", ""]])(
    "is off (503, explicit error, no calls) when %s=%j",
    async (name, value) => {
      vi.stubEnv(name, value);
      const res = await call();
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: "unavailable", message: "The AI assistant isn't available right now." });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no Authorization header", null],
    ["a non-Bearer scheme", `Basic ${TOKEN}`],
    ["a token that isn't a JWT", "Bearer not-a-jwt"],
  ])("refuses %s with 401 before calling Convex or Claude", async (_n, auth) => {
    const res = await call({ auth });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated", message: "Sign in with a Client account to use the AI assistant." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the visitor's token to Convex, which does the verifying", async () => {
    await call();
    expect(calls(CONVEX)[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["Convex rejects the token (expired, forged)", { status: "error", errorMessage: "Unauthenticated: Could not verify OIDC token claim" }, 401],
    ["the account isn't signed up", { status: "success", value: { ok: false, reason: "unauthenticated" } }, 401],
    ["the account is a Developer", { status: "success", value: { ok: false, reason: "not_client" } }, 403],
    ["signed in but no account set up", { status: "success", value: { ok: false, reason: "no_account" } }, 403],
  ])("%s: refused and Claude is never called", async (_n, budget, status) => {
    route({ budget });
    const res = await call();
    expect(res.statusCode).toBe(status);
    expect(calls(ANTHROPIC)).toHaveLength(0);
  });

  it("rejects bad input before spending anything", async () => {
    expect((await call({ body: "{not json" })).statusCode).toBe(400);
    expect((await call({ body: { message: "   " } })).statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks Convex for budget first, with the secret and a hashed visitor key (never the IP)", async () => {
    await call({ ip: "203.0.113.7, 10.0.0.1" });
    const [url, init] = calls(CONVEX)[0];
    expect(url).toBe(`${CONVEX}/api/mutation`);
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ path: "aiBudget:reserveChat", args: { secret: "shared-secret-for-tests" } });
    expect(sent.args.clientKey).toMatch(/^[a-f0-9]{32}$/);
    expect(init.body).not.toContain("203.0.113.7");
  });

  it("the same visitor always maps to the same key; different visitors differ", async () => {
    await call({ ip: "203.0.113.7" });
    await call({ ip: "203.0.113.7" });
    await call({ ip: "198.51.100.9" });
    const keys = calls(CONVEX).map((c) => JSON.parse(c[1].body).args.clientKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([["client_limit"], ["daily_limit"], ["user_limit"]])("over budget (%s): 429 and Claude is never called", async (reason) => {
    route({ budget: { status: "success", value: { ok: false, reason } } });
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("limit");
    expect(calls(ANTHROPIC)).toHaveLength(0);
  });

  it.each([
    ["Convex unreachable", new Error("network down")],
    ["Convex refuses (wrong secret)", { status: "error", errorMessage: "forbidden" }],
  ])("%s: fails closed (503) and Claude is never called", async (_n, budget) => {
    route({ budget });
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(calls(ANTHROPIC)).toHaveLength(0);
  });

  it("works when env values were pasted with trailing whitespace or newlines", async () => {
    vi.stubEnv("CHAT_ENABLED", "true\n");
    vi.stubEnv("ANTHROPIC_API_KEY", " test-key-not-real\n");
    vi.stubEnv("CONVEX_URL", `${CONVEX}\n`);
    vi.stubEnv("RIVET_SERVER_SECRET", "shared-secret-for-tests\r\n");
    const res = await call();
    expect(res.statusCode).toBe(200);
    const [, init] = calls(CONVEX)[0];
    expect(calls(CONVEX)[0][0]).toBe(`${CONVEX}/api/mutation`);
    expect(JSON.parse(init.body).args.secret).toBe("shared-secret-for-tests");
    expect(calls(ANTHROPIC)[0][1].headers["x-api-key"]).toBe("test-key-not-real");
  });

  it("sends a small, low-effort request and returns the reply", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ reply: "Got it: mowing 40 lawns." });
    const sent = JSON.parse(calls(ANTHROPIC)[0][1].body);
    expect(sent).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 2000, output_config: { effort: "low" } });
    expect(calls(ANTHROPIC)[0][1].headers["x-api-key"]).toBe("test-key-not-real");
  });

  it("an Anthropic error becomes a generic 502 without Anthropic's text", async () => {
    route({ model: json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key SECRET-DETAIL" } }) });
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("SECRET-DETAIL");
    expect(JSON.stringify(res.body)).not.toContain("x-api-key");
  });

  it.each([
    ["a refusal", { content: [{ type: "text", text: "partial" }], stop_reason: "refusal" }],
    ["running out of tokens", { content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" }],
    ["an empty reply", { content: [], stop_reason: "end_turn" }],
  ])("%s is reported as a failure, not shown as a reply", async (_n, body) => {
    route({ model: json(200, body) });
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toHaveProperty("reply");
  });

  it("a timeout is reported as 504", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    route({ model: abort });
    expect((await call()).statusCode).toBe(504);
  });
});

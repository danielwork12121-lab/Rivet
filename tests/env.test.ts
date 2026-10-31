// @vitest-environment node
// api/lib/env.js: env values pasted with stray whitespace still work.
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS, no types
import { env } from "../api/lib/env.js";

afterEach(() => vi.unstubAllEnvs());

describe("env()", () => {
  it("trims surrounding whitespace and newlines", () => {
    vi.stubEnv("RIVET_TEST_ENV", "  true\n");
    expect(env("RIVET_TEST_ENV")).toBe("true");
    vi.stubEnv("RIVET_TEST_ENV", "\tabc def\r\n");
    expect(env("RIVET_TEST_ENV")).toBe("abc def");
  });

  it("reads unset and whitespace-only values as an empty string", () => {
    vi.stubEnv("RIVET_TEST_ENV", undefined);
    expect(env("RIVET_TEST_ENV")).toBe("");
    vi.stubEnv("RIVET_TEST_ENV", " \n");
    expect(env("RIVET_TEST_ENV")).toBe("");
  });
});

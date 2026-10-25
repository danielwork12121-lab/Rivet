// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../js/rivet-config.js", import.meta.url), "utf8");
function configFor(href: string, injected?: string) {
  const u = new URL(href);
  const sandbox: any = { location: { hostname: u.protocol === "file:" ? "" : u.hostname, search: u.search }, URLSearchParams };
  if (injected) sandbox.RIVET_CONVEX_URL = injected;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return { backend: sandbox.RIVET_BACKEND, url: sandbox.RIVET_CONVEX_URL };
}

describe("rivet-config", () => {
  it.each([
    "http://127.0.0.1:8080/pages/robot-bounty-client-flow.html",
    "http://localhost:3000/robot-bounty-client-flow",
    "file:///Users/x/Rivet/pages/robot-bounty-client-flow.html",
  ])("%s -> the local backend on this machine", (href) => {
    expect(configFor(href)).toEqual({ backend: "local", url: "http://127.0.0.1:3210" });
  });

  it.each([
    "https://rivet-rose.vercel.app/robot-bounty-client-flow",
    "https://rivet-git-feature-clerk-auth-acme.vercel.app/login",
    "https://example.com/pages/robot-bounty-client-flow.html",
  ])("%s -> cloud, with no URL in the repo (rivet-api.js asks /api/config)", (href) => {
    expect(configFor(href)).toEqual({ backend: "cloud", url: undefined });
  });

  it("names no Convex deployment", () => {
    expect(source).not.toMatch(/\.convex\.cloud/);
  });

  it("?backend= is ignored everywhere", () => {
    for (const q of ["?backend=local", "?backend=cloud", "?backend=preview", "?backend=https://evil.example"]) {
      expect(configFor("https://rivet-rose.vercel.app/" + q)).toEqual({ backend: "cloud", url: undefined });
      expect(configFor("http://127.0.0.1:8080/" + q).url).toBe("http://127.0.0.1:3210");
    }
  });

  it("a URL injected before the script wins and is labelled custom", () => {
    expect(configFor("https://rivet-rose.vercel.app/", "http://127.0.0.1:1")).toEqual({ backend: "custom", url: "http://127.0.0.1:1" });
  });
});

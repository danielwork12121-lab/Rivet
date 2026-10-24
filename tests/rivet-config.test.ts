// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../js/rivet-config.js", import.meta.url), "utf8");
function configFor(href: string) {
  const u = new URL(href);
  const sandbox: any = { location: { hostname: u.protocol === "file:" ? "" : u.hostname, search: u.search }, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return { backend: sandbox.RIVET_BACKEND, url: sandbox.RIVET_CONVEX_URL };
}

describe("rivet-config", () => {
  it.each([
    ["http://127.0.0.1:8080/pages/robot-bounty-client-flow.html", "local"],
    ["http://localhost:3000/robot-bounty-client-flow", "local"],
    ["file:///Users/x/Rivet/pages/robot-bounty-client-flow.html", "local"],
    ["https://rivet-rose.vercel.app/robot-bounty-client-flow", "cloud"],
    ["https://example.com/pages/robot-bounty-client-flow.html", "cloud"], // any non-Vercel host: shared backend
    ["https://some-preview.vercel.app/pages/robot-bounty-client-flow.html", "preview"],
    ["https://rivet-git-feature-clerk-auth-acme.vercel.app/login", "preview"],
    ["https://rivet-9xk2abc-acme.vercel.app/", "preview"],
  ])("%s -> %s", (href, backend) => {
    expect(configFor(href).backend).toBe(backend);
  });

  it("maps names to fixed URLs", () => {
    expect(configFor("http://127.0.0.1:8080/").url).toBe("http://127.0.0.1:3210");
    expect(configFor("https://rivet-rose.vercel.app/").url).toBe("https://coordinated-canary-9.convex.cloud");
    expect(configFor("https://rivet-git-feature-clerk-auth-acme.vercel.app/").url).toBe("https://woozy-warbler-733.convex.cloud");
  });

  it("?backend= overrides explicitly; unknown values are ignored", () => {
    expect(configFor("http://127.0.0.1:8080/?backend=cloud").backend).toBe("cloud");
    // A deployed site never sends sign-in tokens to the visitor's own machine.
    expect(configFor("https://rivet-rose.vercel.app/?backend=local").backend).toBe("cloud");
    expect(configFor("https://rivet-rose.vercel.app/?backend=https://evil.example").backend).toBe("cloud");
  });

  it("a URL injected before the script wins and is labelled custom", () => {
    const sandbox: any = { location: { hostname: "rivet-rose.vercel.app", search: "" }, URLSearchParams, RIVET_CONVEX_URL: "http://127.0.0.1:1" };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);
    expect([sandbox.RIVET_BACKEND, sandbox.RIVET_CONVEX_URL]).toEqual(["custom", "http://127.0.0.1:1"]);
  });
});

describe("rivet-config: previews never reach the shared backend", () => {
  const PREVIEWS = ["https://rivet-git-feature-clerk-auth-acme.vercel.app/", "https://some-preview.vercel.app/", "https://rivet-rose.vercel.app.evil.example/"];
  it("production keeps the shared backend, including a lookalike that only contains its name", () => {
    expect(configFor("https://rivet-rose.vercel.app/pages/login.html").backend).toBe("cloud");
    expect(configFor("https://rivet-rose.vercel.app.evil.example/").backend).toBe("cloud"); // not a *.vercel.app host
  });
  it.each(PREVIEWS.slice(0, 2))("%s ignores ?backend=cloud and ?backend=local", (href) => {
    for (const q of ["?backend=cloud", "?backend=local", "?backend=preview"]) {
      expect(configFor(href + q).url).toBe("https://woozy-warbler-733.convex.cloud");
    }
  });
  it("?backend=preview is ignored off preview hosts, and arbitrary URLs never work", () => {
    expect(configFor("https://rivet-rose.vercel.app/?backend=preview").backend).toBe("cloud");
    expect(configFor("http://127.0.0.1:8080/?backend=preview").backend).toBe("local");
    expect(configFor("https://some-preview.vercel.app/?backend=https://evil.example").url).toBe("https://woozy-warbler-733.convex.cloud");
  });
});

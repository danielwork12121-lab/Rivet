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
    ["https://some-preview.vercel.app/pages/robot-bounty-client-flow.html", "cloud"],
  ])("%s -> %s", (href, backend) => {
    expect(configFor(href).backend).toBe(backend);
  });

  it("maps names to fixed URLs", () => {
    expect(configFor("http://127.0.0.1:8080/").url).toBe("http://127.0.0.1:3210");
    expect(configFor("https://rivet-rose.vercel.app/").url).toBe("https://coordinated-canary-9.convex.cloud");
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

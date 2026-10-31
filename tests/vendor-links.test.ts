// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dumpTemplate } from "../scripts/edit-bundle.mjs";

// message-vendor.html shows the robot the card linked to; the Wright Stander only without params.
const mv = dumpTemplate("pages/message-vendor.html") as string;
const body = mv.match(/static robotFromUrl\(\) \{([\s\S]*?)\n  \}\n  renderVals/)![1];
const robotFor = (search: string) => new Function("window", body)({ location: { search } });

describe("message-vendor robot context", () => {
  it("renders the robot from the link's params", () => {
    const r = robotFor("?name=Test%20Robot&vendor=Acme&price=1234&url=https%3A%2F%2Facme.example%2Fr&img=javascript%3Aalert(1)&requestId=req1");
    expect(r).toMatchObject({ name: "Test Robot", vendor: "Acme", price: "$1,234", url: "https://acme.example/r", img: "", requestId: "req1", sample: false });
    expect(robotFor("?name=X&price=").price).toBe("On request");
  });

  it("only accepts a drawing from Rivet's own img/robots folder", () => {
    expect(robotFor("?name=X&art=%2Fimg%2Frobots%2Fskimmer.svg").art).toBe("/img/robots/skimmer.svg");
    expect(robotFor("?name=X&art=https%3A%2F%2Fevil.example%2Fx.svg").art).toBe("/img/robots/robot.svg");
    expect(robotFor("?name=X&art=%2Fimg%2Frobots%2F..%2F..%2Fx.svg").art).toBe("/img/robots/robot.svg");
  });

  it("every drawing the pages can name exists", () => {
    const fs = dumpTemplate("pages/find-solution.html") as string;
    const kinds = [...fs.matchAll(/\['([a-z-]+)', \/[^\]]+\/\]/g)].map((m) => m[1]).concat("robot", "mower");
    for (const k of kinds) expect(readFileSync(`img/robots/${k}.svg`, "utf8")).toContain("<svg");
  });

  it("falls back to the sample robot with no params", () => {
    expect(robotFor("")).toMatchObject({ name: "Wright Stander with Greenzie autonomy", price: "$33,999", sample: true });
  });

  it("Top matches cards link with the robot's details", () => {
    const fs = dumpTemplate("pages/find-solution.html") as string;
    expect(fs).not.toContain("contactHref: 'message-vendor.html',");
    expect(fs).toMatch(/contactHref: 'message-vendor\.html\?name=' \+ encodeURIComponent\(p\.name\)/);
  });
});

describe("order-confirm page", () => {
  const html = readFileSync("pages/order-confirm.html", "utf8");
  it("loads the auth scripts so the nav reads Account while signed in", () => {
    expect(html).toContain('<script src="../js/rivet-config.js"></script>');
    expect(html).toContain('<script src="../js/rivet-auth.js"></script>');
  });
  it("shows the vendor photo, or a labelled illustration when there is none or it won't load", () => {
    expect(html).toMatch(/addEventListener\('error', showArt\)/);
    expect(html).toContain("'/img/robots/robot.svg'");
    expect(html).toContain('id="r-art-tag"');
    expect(html).not.toMatch(/class="noimg"/);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
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

  it("falls back to the sample robot with no params", () => {
    expect(robotFor("")).toMatchObject({ name: "Wright Stander with Greenzie autonomy", price: "$33,999", sample: true });
  });

  it("Top matches cards link with the robot's details", () => {
    const fs = dumpTemplate("pages/find-solution.html") as string;
    expect(fs).not.toContain("contactHref: 'message-vendor.html',");
    expect(fs).toMatch(/contactHref: 'message-vendor\.html\?name=' \+ encodeURIComponent\(p\.name\)/);
  });
});

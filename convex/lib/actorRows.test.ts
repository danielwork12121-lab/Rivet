import { describe, expect, it } from "vitest";
import { robotFromActorRow } from "./actorRows";

const base = { name: "Mower X", vendor: "Acme", url: "https://acme.com/x", laborReplacedPercent: 60, environments: "outdoor, slopes" };

describe("robotFromActorRow", () => {
  it("keeps a purchase price", () => {
    const r = robotFromActorRow({ ...base, pricingModel: "purchase", purchasePriceUsd: 30000, yearlyCostToRunUsd: 3000 }, "mowing")!;
    expect(r).toMatchObject({ price: 30000, priceStatus: "listed", yearlyOpex: 3000, automationShare: 0.6, task: "mowing" });
    expect(r.environments).toEqual(["outdoor", "slopes"]);
  });

  it("puts a subscription in the yearly cost with nothing up front", () => {
    const r = robotFromActorRow({ ...base, pricingModel: "subscription", priceSummary: "$500/month subscription", yearlyCostToRunUsd: 6000 }, "mowing")!;
    expect(r).toMatchObject({ price: 0, priceStatus: "listed", yearlyOpex: 6000 });
    expect(r.assumptions[0]).toBe("$500/month subscription");
  });

  it("marks no public price as quote only", () => {
    const r = robotFromActorRow({ ...base, pricingModel: "none", yearlyCostToRunUsd: null }, "mowing")!;
    expect(r).toMatchObject({ price: 0, priceStatus: "quote_only", yearlyOpex: 0 });
  });

  it("skips rows with no name or url", () => {
    expect(robotFromActorRow({ vendor: "Acme" }, "mowing")).toBeNull();
  });
});

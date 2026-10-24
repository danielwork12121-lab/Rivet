import { describe, expect, it } from "vitest";
import { robotFromPage, type RawRobotPage } from "./extract.js";
import { toDatasetRow } from "./row.js";

const none = { value: null, unit: null, quote: null };
const page = { url: "https://vendor.example/x1", markdown: "Lease the X1 for $9,000 per year. Runs 6 hours per charge." };
const raw: RawRobotPage = {
  isRobotProduct: true, name: "X1", vendor: "Vendor", priceOnRequest: false,
  price: none, subscription: { value: 9000, unit: "USD", quote: "Lease the X1 for $9,000 per year." }, subscriptionPeriod: "year",
  yearlyRunningCost: none, laborSavedPercent: none,
  specs: [{ name: "runtime_hours", value: 6, unit: "hours", quote: "Runs 6 hours per charge." }],
  environments: ["indoor", "wet"],
};

describe("toDatasetRow", () => {
  it("puts every price and spec in its own column", () => {
    const row = toDatasetRow(robotFromPage(raw, page, "floor scrubbing")!, "2026-10-24T00:00:00.000Z");
    expect(row).toMatchObject({
      priceAvailable: true, pricingModel: "subscription", purchasePriceUsd: null,
      subscriptionBilled: "yearly", monthlySubscriptionUsd: 750, annualSubscriptionUsd: 9000,
      yearlyCostToRunUsd: 9000, laborReplacedPercent: 50,
      runtimeHours: 6, maxSlopeDegrees: null,
      priceQuote: "Lease the X1 for $9,000 per year.",
      specSources: 'runtime_hours: "Runs 6 hours per charge."',
      estimates: "Assumed to replace 50% of the task's labor",
      environments: "indoor, wet",
    });
  });

  it("marks a robot with no public price", () => {
    const row = toDatasetRow(robotFromPage({ ...raw, subscription: none, subscriptionPeriod: null }, page, "x")!, "t");
    expect(row).toMatchObject({
      priceAvailable: false, pricingModel: "none", purchasePriceUsd: null, monthlySubscriptionUsd: null,
      annualSubscriptionUsd: null, yearlyCostToRunUsd: null, priceQuote: null,
      priceSummary: "No public price available. Contact the vendor for a quote.",
    });
  });
});

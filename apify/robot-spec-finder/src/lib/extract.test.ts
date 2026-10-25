import { describe, expect, it } from "vitest";
import { cleanIntent, robotFromPage, type RawRobotPage } from "./extract.js";

const none = { value: null, unit: null, quote: null };

describe("cleanIntent", () => {
  const text = "We mow steep hillside lawns, slopes up to 25 degrees. Mowing costs us about $90,000 a year.";
  const raw = {
    task: " Mowing ", searchPhrase: "commercial robotic mower", annualTaskCost: 90000, budget: 50000,
    requirements: [
      { name: "max_slope_deg" as const, op: "atLeast" as const, value: 25, unit: "degrees", mandatory: true },
      { name: "runtime_hours" as const, op: "atLeast" as const, value: 8, unit: "hours", mandatory: true },
    ],
  };
  it("keeps numbers the operator wrote and drops ones they didn't", () => {
    const intent = cleanIntent(raw, text);
    expect(intent.task).toBe("mowing");
    expect(intent.annualTaskCost).toBe(90000);
    expect(intent.budget).toBeNull(); // $50,000 was never written
    expect(intent.requirements).toEqual([{ name: "max_slope_deg", op: "atLeast", value: 25, mandatory: true }]);
  });
  it("prefers the cost from the intake form", () => {
    expect(cleanIntent(raw, text, 70000).annualTaskCost).toBe(70000);
  });
});

describe("robotFromPage", () => {
  const page = {
    url: "https://vendor.example/x1",
    markdown: "TurfBot X1 costs $18,500. Or lease it for $799/month. Covers 2 acres per hour. Customers cut mowing labor by 60%.",
  };
  const raw: RawRobotPage = {
    isRobotProduct: true, name: "TurfBot X1", vendor: "Vendor", priceOnRequest: false,
    price: { value: 18500, unit: "USD", quote: "TurfBot X1 costs $18,500." },
    subscription: none, subscriptionPeriod: null,
    yearlyRunningCost: none,
    laborSavedPercent: { value: 60, unit: "%", quote: "Customers cut mowing labor by 60%." },
    specs: [
      { name: "coverage_sqft_per_hour", value: 2, unit: "acres/hour", quote: "Covers 2 acres per hour." },
      { name: "max_slope_deg", value: 35, unit: "deg", quote: "Climbs 35 degree slopes." }, // not on the page
    ],
    environments: ["outdoor"],
  };
  const lease = { value: 799, unit: "USD", quote: "Or lease it for $799/month." };

  it("keeps verified facts, converts units and labels assumptions", () => {
    const robot = robotFromPage(raw, page, "Mowing")!;
    expect(robot).toMatchObject({ automationShare: 0.6, yearlyOpex: 1480, task: "mowing" });
    expect(robot.pricing).toEqual({
      model: "purchase", purchasePrice: 18500, subscription: null, note: "$18,500 to buy", quote: "TurfBot X1 costs $18,500.",
    });
    expect(robot.specs).toEqual([
      { name: "coverage_sqft_per_hour", value: 87120, quote: "Covers 2 acres per hour.", sourceUrl: page.url },
    ]);
    expect(robot.assumptions).toEqual(["Running cost estimated at 8% of the price per year"]);
  });

  it("uses a monthly subscription when there is no purchase price", () => {
    const robot = robotFromPage({ ...raw, price: none, subscription: lease, subscriptionPeriod: "month" }, page, "mowing")!;
    expect(robot.pricing).toMatchObject({
      model: "subscription", purchasePrice: null,
      subscription: { price: 799, period: "month", perYear: 9588 },
      note: "$799 per month ($9,588 a year), no purchase price listed",
    });
    expect(robot.yearlyOpex).toBe(9588);
    expect(robot.assumptions).not.toContain("Running cost estimated at 8% of the price per year");
  });

  it("counts a subscription on top of a purchase as the running cost", () => {
    const robot = robotFromPage({ ...raw, subscription: lease, subscriptionPeriod: "month" }, page, "mowing")!;
    expect(robot.pricing.model).toBe("purchase");
    expect(robot.pricing.note).toBe("$18,500 to buy, plus $799 per month");
    expect(robot.yearlyOpex).toBe(9588);
  });

  it("says no public price when there is neither", () => {
    const robot = robotFromPage({ ...raw, price: none, priceOnRequest: true }, page, "mowing")!;
    expect(robot.pricing).toEqual({
      model: "none", purchasePrice: null, subscription: null,
      note: "No public price available. Contact the vendor for a quote.", quote: null,
    });
    expect(robot.yearlyOpex).toBeNull();
  });

  it("ignores a subscription price that isn't on the page", () => {
    const fake = { value: 499, unit: "USD", quote: "Only $499 a month!" };
    const robot = robotFromPage({ ...raw, price: none, subscription: fake, subscriptionPeriod: "month" }, page, "mowing")!;
    expect(robot.pricing.model).toBe("none");
  });

  it("skips pages that aren't a robot product", () => {
    expect(robotFromPage({ ...raw, isRobotProduct: false }, page, "mowing")).toBeNull();
  });
});

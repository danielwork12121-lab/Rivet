import { describe, expect, it } from "vitest";
import { cleanIntent, robotFromPage, type RawRobotPage } from "./extract";

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
    markdown: "TurfBot X1 costs $18,500. Covers 2 acres per hour. Customers cut mowing labor by 60%.",
  };
  const raw: RawRobotPage = {
    isRobotProduct: true, name: "TurfBot X1", vendor: "Vendor", priceOnRequest: false,
    price: { value: 18500, unit: "USD", quote: "TurfBot X1 costs $18,500." },
    yearlyRunningCost: none,
    laborSavedPercent: { value: 60, unit: "%", quote: "Customers cut mowing labor by 60%." },
    specs: [
      { name: "coverage_sqft_per_hour", value: 2, unit: "acres/hour", quote: "Covers 2 acres per hour." },
      { name: "max_slope_deg", value: 35, unit: "deg", quote: "Climbs 35 degree slopes." }, // not on the page
    ],
    environments: ["outdoor"],
  };
  it("keeps verified facts, converts units and labels assumptions", () => {
    const robot = robotFromPage(raw, page, "Mowing")!;
    expect(robot).toMatchObject({ price: 18500, priceStatus: "listed", automationShare: 0.6, yearlyOpex: 1480, task: "mowing" });
    expect(robot.specs).toEqual([
      { name: "coverage_sqft_per_hour", value: 87120, quote: "Covers 2 acres per hour.", sourceUrl: page.url },
    ]);
    expect(robot.assumptions).toEqual(["Running cost estimated at 8% of the price per year"]);
  });
  it("stores an unlisted price as quote-only", () => {
    const robot = robotFromPage({ ...raw, price: none, priceOnRequest: true }, page, "mowing")!;
    expect(robot).toMatchObject({ price: 0, priceStatus: "quote_only", yearlyOpex: 0 });
  });
  it("skips pages that aren't a robot product", () => {
    expect(robotFromPage({ ...raw, isRobotProduct: false }, page, "mowing")).toBeNull();
  });
});

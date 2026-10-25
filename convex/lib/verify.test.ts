import { describe, expect, it } from "vitest";
import { numberAppears, verifyEvidence } from "./verify";
import { toCanonical } from "./specs";
import { breakEvenAnnualCost } from "./roi";

const page = `## TurfBot X1\n\nStarting at **$18,500**. Runs up to 4.5 hours per charge\nand mows slopes up to 25°.`;

describe("verifyEvidence", () => {
  it("keeps a number whose quote is on the page", () => {
    const e = { value: 18500, unit: "USD", quote: "Starting at $18,500." };
    expect(verifyEvidence(e, page).value).toBe(18500);
  });
  it("ignores markdown and line breaks when matching the quote", () => {
    const e = { value: 4.5, unit: "hours", quote: "Runs up to 4.5 hours per charge and mows slopes up to 25°." };
    expect(verifyEvidence(e, page).value).toBe(4.5);
  });
  it("drops a quote that isn't on the page", () => {
    const e = { value: 30, unit: "deg", quote: "Handles slopes up to 30°." };
    expect(verifyEvidence(e, page).value).toBeNull();
  });
  it("drops a number that isn't in its quote", () => {
    const e = { value: 19000, unit: "USD", quote: "Starting at $18,500." };
    expect(verifyEvidence(e, page).value).toBeNull();
  });
});

describe("numberAppears", () => {
  it("finds numbers with commas and decimals, not inside other numbers", () => {
    expect(numberAppears(90000, "we spend about $90,000 a year")).toBe(true);
    expect(numberAppears(2.5, "2.5 acres")).toBe(true);
    expect(numberAppears(25, "slopes of 250 feet")).toBe(false);
    expect(numberAppears(5, "about 2.5 hours")).toBe(false);
  });
});

describe("toCanonical", () => {
  it("converts units by code", () => {
    expect(toCanonical("coverage_sqft_per_hour", 2, "acres/hr")).toBe(87120);
    expect(toCanonical("runtime_hours", 90, "minutes")).toBe(1.5);
    expect(toCanonical("payload_kg", 100, "lbs")).toBe(45.36);
    expect(toCanonical("max_slope_deg", 100, "%")).toBe(45);
    expect(toCanonical("tank_liters", 10, "furlongs")).toBeNull();
  });
});

describe("breakEvenAnnualCost", () => {
  it("is the yearly task cost at which payback takes 24 months", () => {
    // needs 16,000 net a year; +2,000 opex = 18,000 labor saved; / 0.6 = 30,000
    expect(breakEvenAnnualCost({ robotPrice: 32000, yearlyOpex: 2000, automationShare: 0.6 })).toBe(30000);
  });
});

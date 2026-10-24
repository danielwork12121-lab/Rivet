import { describe, expect, it } from "vitest";
import { computeRoi, suggestBounty } from "./roi";

describe("computeRoi", () => {
  it("matches a hand-checked example", () => {
    // $40,000/yr task, robot replaces 70% = $28,000 saved,
    // minus $4,000 opex = $24,000 net. $18,000 robot / $24,000 * 12 = 9 months.
    const r = computeRoi({ currentAnnualCost: 40000, robotPrice: 18000, yearlyOpex: 4000, automationShare: 0.7 });
    expect(r).toEqual({
      yearlyLaborSaved: 28000,
      yearlyNetSavings: 24000,
      paybackMonths: 9,
      paybackRange: [8, 11],
    });
  });

  it("says never pays back when opex eats the savings", () => {
    const r = computeRoi({ currentAnnualCost: 5000, robotPrice: 18000, yearlyOpex: 4000, automationShare: 0.5 });
    expect(r.paybackMonths).toBeNull();
  });
});

describe("suggestBounty", () => {
  it("is 30% of net savings, rounded to $100", () => {
    expect(suggestBounty(24000)).toBe(7200);
    expect(suggestBounty(-100)).toBe(0);
  });
});
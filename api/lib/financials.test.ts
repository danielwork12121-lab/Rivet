import { describe, expect, it } from "vitest";
import {
  computeMargins,
  estimateAutomationImpact,
  extractNumbers,
  groundFields,
  isGrounded,
  reconcileProcess,
  reconcileTotals,
  summarizeSheets,
} from "./financials.js";

describe("extractNumbers", () => {
  it("finds plain and comma-formatted numbers", () => {
    const nums = extractNumbers("Revenue | 1,200,000\nCOGS | 700000\nNote | n/a");
    expect(nums.has(1200000)).toBe(true);
    expect(nums.has(700000)).toBe(true);
  });

  it("ignores stray punctuation", () => {
    const nums = extractNumbers("just a dash - and a dot .");
    expect(nums.size).toBe(0);
  });
});

describe("isGrounded / groundFields", () => {
  const ground = extractNumbers("Mowing crew annual cost: 180,000. Hourly rate: 24.");

  it("accepts a number that appears in the source", () => {
    expect(isGrounded(180000, ground)).toBe(true);
    expect(isGrounded(24, ground)).toBe(true);
  });

  it("rejects a number the model made up", () => {
    expect(isGrounded(999999, ground)).toBe(false);
  });

  it("nulls out only the ungrounded fields and reports them", () => {
    const { cleaned, dropped } = groundFields(
      { totals: { revenue: 180000, cogs: 999999 } },
      ["totals.revenue", "totals.cogs"],
      ground,
    );
    expect(cleaned.totals.revenue).toBe(180000);
    expect(cleaned.totals.cogs).toBeNull();
    expect(dropped).toEqual(["totals.cogs"]);
  });

  it("never mutates the input object", () => {
    const input = { totals: { revenue: 999999 } };
    groundFields(input, ["totals.revenue"], ground);
    expect(input.totals.revenue).toBe(999999);
  });
});

describe("computeMargins", () => {
  it("derives gross and net margin from revenue/cogs/opex when no profit line is stated", () => {
    const m = computeMargins({ revenue: 1200000, cogs: 700000, grossProfit: null, operatingExpenses: 300000, netProfit: null });
    expect(m.grossProfit).toBe(500000);
    expect(m.grossMarginPct).toBeCloseTo(41.7, 1);
    expect(m.netProfit).toBe(200000);
    expect(m.netMarginPct).toBeCloseTo(16.7, 1);
  });

  it("prefers a stated profit line over a derived one", () => {
    const m = computeMargins({ revenue: 1000000, cogs: 600000, grossProfit: 450000, operatingExpenses: 200000, netProfit: 260000 });
    expect(m.grossProfit).toBe(450000);
    expect(m.netProfit).toBe(260000);
  });

  it("leaves margins null when revenue is unknown", () => {
    const m = computeMargins({ revenue: null, cogs: null, grossProfit: null, operatingExpenses: null, netProfit: null });
    expect(m.grossMarginPct).toBeNull();
    expect(m.netMarginPct).toBeNull();
  });
});

// Test E from the Cal Hacks demo review: a financial workbook with deliberately incorrect or
// inconsistent values (the Summit Grounds case). reconcileTotals/reconcileProcess below are the
// functions that catch this -- every correction is reported (never a silent overwrite), and
// buildCorrectedWorkbook (api/lib/corrected-workbook.test.ts) proves the original, corrected and
// reasoning all end up in the workbook the operator gets back.
describe("reconcileTotals", () => {
  it("leaves consistent totals untouched with no corrections", () => {
    const { totals, corrections } = reconcileTotals({ revenue: 1000000, cogs: 600000, grossProfit: 400000, operatingExpenses: 150000, netProfit: 250000 });
    expect(totals.grossProfit).toBe(400000);
    expect(totals.netProfit).toBe(250000);
    expect(corrections).toEqual([]);
  });

  it("corrects a stated gross profit that doesn't equal revenue minus cogs", () => {
    const { totals, corrections } = reconcileTotals({ revenue: 1000000, cogs: 600000, grossProfit: 350000, operatingExpenses: null, netProfit: null });
    expect(totals.grossProfit).toBe(400000);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].field).toBe("totals.grossProfit");
    expect(corrections[0].original).toBe(350000);
    expect(corrections[0].corrected).toBe(400000);
  });

  it("cascades a gross-profit correction into the net-profit check", () => {
    // grossProfit is wrong (should be 400000, not 350000); netProfit (250000)
    // is actually consistent with the *corrected* gross profit (400000 - 150000),
    // so only grossProfit should be flagged, not netProfit.
    const { totals, corrections } = reconcileTotals({ revenue: 1000000, cogs: 600000, grossProfit: 350000, operatingExpenses: 150000, netProfit: 250000 });
    expect(totals.grossProfit).toBe(400000);
    expect(totals.netProfit).toBe(250000);
    expect(corrections.map((c) => c.field)).toEqual(["totals.grossProfit"]);
  });

  it("tolerates a one- or two-dollar rounding difference", () => {
    const { corrections } = reconcileTotals({ revenue: 1000000, cogs: 600000, grossProfit: 399999, operatingExpenses: null, netProfit: null });
    expect(corrections).toEqual([]);
  });
});

describe("reconcileProcess", () => {
  it("corrects an annual cost that doesn't match crew math", () => {
    const { process, corrections } = reconcileProcess({
      name: "Mowing crew",
      annualCost: 150000,
      crewCount: 2,
      peoplePerCrew: 2,
      hoursPerWeek: 40,
      weeksPerYear: 48,
      hourlyLaborCost: 24,
    });
    // 2 * 2 * 40 * 48 * 24 = 184320
    expect(process.annualCost).toBe(184320);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].original).toBe(150000);
    expect(corrections[0].corrected).toBe(184320);
  });

  it("derives annual cost when it wasn't stated at all", () => {
    const { process, corrections } = reconcileProcess({
      name: "Spray crew",
      annualCost: null,
      crewCount: 1,
      peoplePerCrew: 1,
      hoursPerWeek: 20,
      weeksPerYear: 40,
      hourlyLaborCost: 22,
    });
    expect(process.annualCost).toBe(17600);
    expect(corrections[0].original).toBeNull();
  });

  it("leaves a consistent annual cost alone", () => {
    const { process, corrections } = reconcileProcess({
      name: "Edging crew",
      annualCost: 96000,
      crewCount: 1,
      peoplePerCrew: 2,
      hoursPerWeek: 20,
      weeksPerYear: 48,
      hourlyLaborCost: 50,
    });
    expect(process.annualCost).toBe(96000);
    expect(corrections).toEqual([]);
  });

  it("does nothing when crew inputs are incomplete", () => {
    const { process, corrections } = reconcileProcess({ name: "Mystery crew", annualCost: 50000, crewCount: null });
    expect(process.annualCost).toBe(50000);
    expect(corrections).toEqual([]);
  });
});

describe("estimateAutomationImpact", () => {
  it("projects a low/high net-profit range -- 55% labor displacement conservative, 75% + secondary effects optimistic", () => {
    const impact = estimateAutomationImpact({ name: "Mowing crew", annualCost: 200000 }, { revenue: 1000000, netProfit: 100000 });
    expect(impact.process).toBe("Mowing crew");
    expect(impact.currentAnnualCost).toBe(200000);
    expect(impact.currentNetProfit).toBe(100000);

    // Low (conservative): 55% labor displacement only, no secondary benefits.
    expect(impact.low.laborDisplacementRate).toBe(0.55);
    expect(impact.low.laborSavings).toBe(110000);
    expect(impact.low.insuranceSavings).toBe(0);
    expect(impact.low.totalAnnualBenefit).toBe(110000);
    expect(impact.low.projectedNetProfit).toBe(210000);
    expect(impact.low.projectedNetMarginPct).toBeCloseTo(21, 1);

    // High (optimistic): 75% labor displacement + 15% insurance/benefits on
    // displaced wages. No gross margin was stated here, so capacity uplift
    // (which needs a margin to price new revenue at) is zero.
    expect(impact.high.laborDisplacementRate).toBe(0.75);
    expect(impact.high.laborSavings).toBe(150000);
    expect(impact.high.insuranceSavings).toBe(22500);
    expect(impact.high.totalAnnualBenefit).toBe(172500);
    expect(impact.high.projectedNetProfit).toBe(272500);
    expect(impact.high.projectedNetMarginPct).toBeCloseTo(27.3, 1);
  });

  it("derives annualCost from crew/hours/rate when it's null but the components are stated", () => {
    const impact = estimateAutomationImpact(
      { name: "Mowing crew", annualCost: null, crewCount: 4, peoplePerCrew: 3, hoursPerWeek: 40, weeksPerYear: 40, hourlyLaborCost: 20 },
      { revenue: 1000000, netProfit: 100000 },
    );
    expect(impact).not.toBeNull();
    expect(impact.currentAnnualCost).toBe(384000);
  });

  it("returns null when there's no process or no way to determine annual cost", () => {
    expect(estimateAutomationImpact(null, { revenue: 1 })).toBeNull();
    expect(estimateAutomationImpact({ name: "x", annualCost: null }, { revenue: 1 })).toBeNull();
  });

  // Section 4 of the Cal Hacks demo-reliability review: this range is a generic labor-displacement
  // percentage, not a robot-specific projection, and must never be presented as a verified figure.
  it("is always labeled hypothetical, with limitations explaining what it doesn't check", () => {
    const impact = estimateAutomationImpact({ name: "Mowing crew", annualCost: 200000 }, { revenue: 1000000, netProfit: 100000 });
    expect(impact.confidence).toBe("hypothetical");
    expect(impact.limitations.length).toBeGreaterThan(0);
    expect(impact.limitations.join(" ")).toMatch(/fleet/);
    expect(impact.note).toMatch(/^Hypothetical scenario, not a verified projection/);
    expect(impact.laborCostWasCorrected).toBe(false);
  });

  it("flags when the labor cost behind the estimate had to be corrected", () => {
    const impact = estimateAutomationImpact(
      { name: "Mowing crew", annualCost: 200000 }, { revenue: 1000000, netProfit: 100000 },
      { laborCostWasCorrected: true },
    );
    expect(impact.laborCostWasCorrected).toBe(true);
    expect(impact.limitations.join(" ")).toMatch(/did not match the sheet/);
  });
});

describe("summarizeSheets", () => {
  it("joins sheets into labeled, pipe-separated blocks", () => {
    const { text, truncated } = summarizeSheets([
      { name: "P&L", rows: [["Revenue", "1200000"], ["COGS", "700000"]] },
    ]);
    expect(text).toContain("=== Sheet: P&L ===");
    expect(text).toContain("Revenue | 1200000");
    expect(truncated).toBe(false);
  });

  it("truncates a sheet with more rows than the cap and flags it", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`row${i}`, String(i)]);
    const { text, truncated } = summarizeSheets([{ name: "Big", rows }], { maxRows: 2 });
    expect(truncated).toBe(true);
    expect(text).toContain("…(truncated)");
    expect(text).not.toContain("row4");
  });

  it("drops extra sheets past maxSheets", () => {
    const sheets = [
      { name: "A", rows: [["x"]] },
      { name: "B", rows: [["y"]] },
    ];
    const { text, truncated } = summarizeSheets(sheets, { maxSheets: 1 });
    expect(text).toContain("Sheet: A");
    expect(text).not.toContain("Sheet: B");
    expect(truncated).toBe(true);
  });
});

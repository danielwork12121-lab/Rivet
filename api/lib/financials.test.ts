import { describe, expect, it } from "vitest";
import { computeMargins, extractNumbers, groundFields, isGrounded, summarizeSheets } from "./financials.js";

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

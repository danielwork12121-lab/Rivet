import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildCorrectedWorkbook } from "./corrected-workbook.js";

describe("buildCorrectedWorkbook", () => {
  it("writes a readable .xlsx with the corrected totals, processes, impact and a corrections log", async () => {
    const extraction = {
      totals: { revenue: 1000000, cogs: 600000, grossProfit: 400000, grossMarginPct: 40, operatingExpenses: 150000, netProfit: 250000, netMarginPct: 25 },
      processes: [
        { name: "Mowing crew", annualCost: 368640, crewCount: 2, peoplePerCrew: 2, hoursPerWeek: 40, weeksPerYear: 48, hourlyLaborCost: 24, automationCandidate: true },
      ],
    };
    const corrections = [
      { field: "totals.grossProfit", original: 350000, corrected: 400000, reason: "Stated gross profit didn't equal revenue − COGS; corrected." },
      { field: "Mowing crew.annualCost", original: 150000, corrected: 368640, reason: "Stated annual cost didn't match crew math; corrected." },
    ];
    const impact = {
      process: "Mowing crew",
      currentAnnualCost: 368640,
      currentNetProfit: 250000,
      currentGrossMarginPct: 40,
      low: {
        laborDisplacementRate: 0.55,
        laborSavings: 202752,
        insuranceSavings: 0,
        capacityRevenue: 0,
        capacityProfit: 0,
        totalAnnualBenefit: 202752,
        projectedNetProfit: 452752,
        projectedNetMarginPct: 45.3,
      },
      high: {
        laborDisplacementRate: 0.75,
        laborSavings: 276480,
        insuranceSavings: 41472,
        capacityRevenue: 345600,
        capacityProfit: 138240,
        totalAnnualBenefit: 456192,
        projectedNetProfit: 706192,
        projectedNetMarginPct: 52.5,
      },
      note: "Low estimate: 55% labor displacement, no secondary benefits. High estimate: 75% labor displacement + secondary effects.",
    };

    const buf = await buildCorrectedWorkbook({ extraction, corrections, impact, sourceFileName: "financials.xlsx" });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((ws) => ws.name);
    expect(names).toEqual(["Corrected P&L", "Corrected Processes", "Robot Impact Projection", "Corrections Log", "About this file"]);

    const pl = wb.getWorksheet("Corrected P&L");
    expect(pl.getRow(4).getCell(2).value).toBe(400000); // Gross profit, corrected value

    const log = wb.getWorksheet("Corrections Log");
    expect(log.getRow(2).getCell(1).value).toBe("totals.grossProfit");
    expect(log.getRow(2).getCell(2).value).toBe(350000);
    expect(log.getRow(2).getCell(3).value).toBe(400000);

    const impactWs = wb.getWorksheet("Robot Impact Projection");
    expect(impactWs.getRow(2).getCell(2).value).toBe("Mowing crew"); // Recommended process
    expect(impactWs.getRow(3).getCell(2).value).toBe(368640); // Current annual cost of process
    expect(impactWs.getRow(5).getCell(2).value).toBe(202752); // Direct labor savings, conservative
    expect(impactWs.getRow(5).getCell(3).value).toBe(276480); // Direct labor savings, optimistic
  });

  it("still produces a valid workbook when there are no corrections and no impact", async () => {
    const extraction = { totals: { revenue: null, cogs: null, grossProfit: null, grossMarginPct: null, operatingExpenses: null, netProfit: null, netMarginPct: null }, processes: [] };
    const buf = await buildCorrectedWorkbook({ extraction, corrections: [], impact: null, sourceFileName: "empty.xlsx" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet("Corrections Log").getCell("A2").value).toMatch(/No corrections were needed/);
    expect(wb.getWorksheet("Robot Impact Projection").getCell("A1").value).toMatch(/Not enough grounded figures/);
  });
});

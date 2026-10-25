// Builds the downloadable "corrected" .xlsx handed back from
// /api/analyze-excel: the operator's own figures, with anything that didn't
// reconcile swapped for the computed value (api/lib/financials.js's
// reconcileTotals/reconcileProcess), a plain audit trail of what changed and
// why, and a before/after profit projection for the recommended process
// (estimateAutomationImpact). Kept in its own module, same reasoning as
// workbook.js: this is the only file besides workbook.js that touches
// ExcelJS, so financials.js stays dependency-free and fast to unit test.

import ExcelJS from "exceljs";

function money(n) {
  return typeof n === "number" ? n : null;
}

function addTable(ws, headers, rows, { startRow = 1 } = {}) {
  const headerRow = ws.getRow(startRow);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  rows.forEach((row, r) => {
    row.forEach((v, c) => {
      ws.getRow(startRow + 1 + r).getCell(c + 1).value = v;
    });
  });
  ws.columns.forEach((col, i) => {
    const headerLen = String(headers[i] || "").length;
    const maxCellLen = rows.reduce((m, row) => Math.max(m, String(row[i] ?? "").length), 0);
    col.width = Math.min(60, Math.max(12, headerLen, maxCellLen) + 2);
  });
}

// `extraction` is the same object /api/analyze-excel.js returns to the
// client (already reconciled/grounded); `corrections` and `impact` are its
// `corrections` and `impact` fields. Returns a Node Buffer of the .xlsx.
export async function buildCorrectedWorkbook({ extraction, corrections, impact, sourceFileName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Rivet";
  wb.created = new Date();

  const pl = wb.addWorksheet("Corrected P&L");
  const t = extraction?.totals || {};
  addTable(
    pl,
    ["Line", "Corrected amount", "Note"],
    [
      ["Revenue", money(t.revenue), ""],
      ["Cost of goods / services sold (COGS)", money(t.cogs), ""],
      ["Gross profit", money(t.grossProfit), corrections?.some((c) => c.field === "totals.grossProfit") ? "Corrected -- see Corrections Log" : ""],
      ["Gross margin %", t.grossMarginPct, ""],
      ["Operating expenses", money(t.operatingExpenses), ""],
      ["Net profit", money(t.netProfit), corrections?.some((c) => c.field === "totals.netProfit") ? "Corrected -- see Corrections Log" : ""],
      ["Net margin %", t.netMarginPct, ""],
    ],
  );

  const procs = wb.addWorksheet("Corrected Processes");
  const processRows = (extraction?.processes || []).map((p) => {
    const wasCorrected = (corrections || []).some((c) => c.field === `${p.name}.annualCost`);
    return [
      p.name,
      money(p.annualCost),
      p.crewCount ?? "",
      p.peoplePerCrew ?? "",
      p.hoursPerWeek ?? "",
      p.weeksPerYear ?? "",
      p.hourlyLaborCost ?? "",
      p.automationCandidate ? "Yes" : "No",
      wasCorrected ? "Corrected -- see Corrections Log" : "",
    ];
  });
  addTable(
    procs,
    ["Process / crew", "Annual cost", "Crew count", "People per crew", "Hours/week", "Weeks/year", "Hourly labor cost", "Automation candidate", "Note"],
    processRows,
  );

  const impactWs = wb.addWorksheet("Robot Impact Projection");
  if (impact && impact.low && impact.high) {
    addTable(
      impactWs,
      ["Field", "Conservative", "Optimistic"],
      [
        ["Recommended process", impact.process, impact.process],
        ["Current annual cost of process", money(impact.currentAnnualCost), money(impact.currentAnnualCost)],
        ["Labor displacement rate", `${Math.round(impact.low.laborDisplacementRate * 100)}%`, `${Math.round(impact.high.laborDisplacementRate * 100)}%`],
        ["Direct labor savings", money(impact.low.laborSavings), money(impact.high.laborSavings)],
        ["Insurance/benefits savings", money(impact.low.insuranceSavings), money(impact.high.insuranceSavings)],
        ["Capacity uplift (new revenue)", money(impact.low.capacityRevenue), money(impact.high.capacityRevenue)],
        ["Capacity uplift (profit at margin)", money(impact.low.capacityProfit), money(impact.high.capacityProfit)],
        ["Total annual benefit", money(impact.low.totalAnnualBenefit), money(impact.high.totalAnnualBenefit)],
        ["Current net profit", money(impact.currentNetProfit), money(impact.currentNetProfit)],
        ["Projected net profit", money(impact.low.projectedNetProfit), money(impact.high.projectedNetProfit)],
        ["Projected net margin %", impact.low.projectedNetMarginPct, impact.high.projectedNetMarginPct],
        ["Assumptions", impact.note, impact.note],
      ],
    );
  } else {
    impactWs.getCell("A1").value = "Not enough grounded figures to project an impact for this sheet.";
  }

  const log = wb.addWorksheet("Corrections Log");
  addTable(
    log,
    ["Field", "Original (as entered)", "Corrected", "Reason"],
    (corrections || []).map((c) => [c.field, c.original ?? "(not stated)", c.corrected, c.reason]),
  );
  if (!corrections || corrections.length === 0) {
    log.getCell("A2").value = "No corrections were needed -- every figure reconciled against the sheet.";
  }

  const meta = wb.addWorksheet("About this file");
  addTable(
    meta,
    ["Field", "Value"],
    [
      ["Source file", sourceFileName || "(unknown)"],
      ["Generated by", "Rivet -- Excel Input"],
      ["Generated at", new Date().toISOString()],
      [
        "How to read this",
        "Every figure below is grounded against your original sheet and arithmetic-checked (revenue − COGS = gross profit, " +
          "gross profit − operating expenses = net profit, crew size × hours/week × weeks/year × hourly rate = annual cost). " +
          "Anything that didn't check out was replaced with the computed figure; see Corrections Log for exactly what changed.",
      ],
    ],
  );

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

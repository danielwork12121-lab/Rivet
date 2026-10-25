// Pure, testable helpers for the Excel-intake route (api/analyze-excel.js).
// Mirrors convex/lib/roi.ts's rule: the model extracts facts, plain
// functions do every calculation and every groundedness check. Nothing here
// talks to Claude or to a workbook library, so it's cheap to unit test.

// Every distinct number (rounded to the nearest integer) that appears
// anywhere in a block of text. Used to check a claimed figure actually came
// from the sheet rather than being invented by the model.
export function extractNumbers(text) {
  const found = new Set();
  const re = /-?\d[\d,]*\.?\d*/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const cleaned = m[0].replace(/,/g, "");
    if (cleaned === "" || cleaned === "." || cleaned === "-") continue;
    const n = parseFloat(cleaned);
    if (!isNaN(n)) found.add(Math.round(n));
  }
  return found;
}

// A claimed number is grounded if it's within `tolerance` of some number
// that literally appeared in the source sheet (rounding/formatting in how a
// cell was read can shift a figure by a dollar or two).
export function isGrounded(value, groundSet, tolerance = 1) {
  if (value === null || value === undefined || typeof value !== "number" || isNaN(value)) return false;
  const rounded = Math.round(value);
  for (const g of groundSet) {
    if (Math.abs(g - rounded) <= tolerance) return true;
  }
  return false;
}

// Nulls out any numeric field (by dotted path) that isn't grounded, and
// reports which ones were dropped. Never mutates the input.
export function groundFields(obj, paths, groundSet) {
  const cleaned = JSON.parse(JSON.stringify(obj ?? {}));
  const dropped = [];
  for (const path of paths) {
    const parts = path.split(".");
    let parent = cleaned;
    for (let i = 0; i < parts.length - 1; i++) {
      if (parent == null) break;
      parent = parent[parts[i]];
    }
    if (parent == null) continue;
    const key = parts[parts.length - 1];
    const v = parent[key];
    if (v !== null && v !== undefined && !isGrounded(v, groundSet)) {
      parent[key] = null;
      dropped.push(path);
    }
  }
  return { cleaned, dropped };
}

function numOrNull(v) {
  return typeof v === "number" && !isNaN(v) ? v : null;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// Two numbers count as "the same" if they're within a dollar or two, or
// within relTol of each other -- small enough to catch a real typo or
// transposition (the kind this feature is meant to catch), loose enough not
// to flag honest cent-level rounding in a sheet.
function approxEqual(a, b, relTol = 0.01, absTol = 2) {
  if (typeof a !== "number" || typeof b !== "number" || isNaN(a) || isNaN(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b));
}

// Groundedness (above) only asks "did this number appear in the sheet at
// all". Reconciliation goes one step further: it checks whether a *stated*
// figure is internally consistent with the other stated figures it's
// supposed to add up from, the same way a careful bookkeeper would re-foot a
// sheet before trusting it. When a stated figure doesn't reconcile, it's
// treated the same way an ungrounded number is -- dropped and replaced with
// the deterministically-computed value -- and the swap is recorded as a
// correction so the operator can see exactly what changed and why. Claude
// never does this arithmetic; it only supplies the stated figures being
// checked.
//
// Returns { totals, corrections } where `totals` has the same shape
// computeMargins expects (any inconsistent stated field replaced by its
// derived value) and `corrections` is a list of { field, original,
// corrected, reason }, oldest fix first.
export function reconcileTotals(totals) {
  const corrections = [];
  const revenue = numOrNull(totals?.revenue);
  const cogs = numOrNull(totals?.cogs);
  const operatingExpenses = numOrNull(totals?.operatingExpenses);
  let grossProfit = numOrNull(totals?.grossProfit);

  const derivedGrossProfit = revenue !== null && cogs !== null ? revenue - cogs : null;
  if (grossProfit !== null && derivedGrossProfit !== null && !approxEqual(grossProfit, derivedGrossProfit)) {
    corrections.push({
      field: "totals.grossProfit",
      original: grossProfit,
      corrected: derivedGrossProfit,
      reason: "Stated gross profit didn't equal revenue − COGS on the sheet; corrected to revenue − COGS.",
    });
    grossProfit = derivedGrossProfit;
  }

  let netProfit = numOrNull(totals?.netProfit);
  const effectiveGrossProfit = grossProfit !== null ? grossProfit : derivedGrossProfit;
  const derivedNetProfit =
    effectiveGrossProfit !== null && operatingExpenses !== null ? effectiveGrossProfit - operatingExpenses : null;
  if (netProfit !== null && derivedNetProfit !== null && !approxEqual(netProfit, derivedNetProfit)) {
    corrections.push({
      field: "totals.netProfit",
      original: netProfit,
      corrected: derivedNetProfit,
      reason: "Stated net profit didn't equal gross profit − operating expenses on the sheet; corrected to match.",
    });
    netProfit = derivedNetProfit;
  }

  return {
    totals: { revenue, cogs, grossProfit, operatingExpenses, netProfit },
    corrections,
  };
}

// Same idea, one process at a time: a process's annual cost should equal
// crewCount × peoplePerCrew × hoursPerWeek × weeksPerYear × hourlyLaborCost
// whenever the sheet states (or implies) all five of those. When it's
// stated but doesn't match, the computed figure wins and the swap is
// logged; when it isn't stated at all, the computed figure fills it in
// (also logged, so it's clear the number was derived, not read off the
// sheet).
export function reconcileProcess(process) {
  const p = { ...process };
  const corrections = [];
  const { crewCount, peoplePerCrew, hoursPerWeek, weeksPerYear, hourlyLaborCost } = p;
  const inputs = [crewCount, peoplePerCrew, hoursPerWeek, weeksPerYear, hourlyLaborCost];
  const haveAllInputs = inputs.every((v) => typeof v === "number" && !isNaN(v));

  if (haveAllInputs) {
    const computed = Math.round(crewCount * peoplePerCrew * hoursPerWeek * weeksPerYear * hourlyLaborCost);
    if (typeof p.annualCost === "number" && !approxEqual(p.annualCost, computed)) {
      corrections.push({
        field: `${p.name || "process"}.annualCost`,
        original: p.annualCost,
        corrected: computed,
        reason: `Stated annual cost for "${p.name || "this process"}" didn't match crew size × hours/week × weeks/year × hourly rate; corrected to the computed figure.`,
      });
      p.annualCost = computed;
    } else if (p.annualCost === null || p.annualCost === undefined) {
      corrections.push({
        field: `${p.name || "process"}.annualCost`,
        original: null,
        corrected: computed,
        reason: `Annual cost wasn't stated directly for "${p.name || "this process"}"; derived from crew size × hours/week × weeks/year × hourly rate.`,
      });
      p.annualCost = computed;
    }
  }

  return { process: p, corrections };
}

// Comprehensive ROI projection with LOW and HIGH range.
//
// LOW estimate  (conservative): ~55% labor displacement, no secondary
//   benefits — the floor of what automation realistically delivers.
// HIGH estimate (optimistic): ~75% labor displacement + insurance/benefits
//   reduction (~15% of displaced wages) + capacity uplift (freed labor
//   hours converted to new revenue at the company's gross margin).
//
// Both estimates are deterministic functions of the sheet's own numbers,
// so they're reproducible and auditable.  The range stays tight enough to
// look credible while being wide enough to be honest.

// --- Assumption constants ---------------------------------------------------
const LOW_LABOR_DISPLACEMENT  = 0.55;  // conservative: 55% of labor automated
const HIGH_LABOR_DISPLACEMENT = 0.75;  // optimistic:  75% of labor automated

// Insurance + benefits burden as a % of displaced wages (workers' comp,
// health, payroll taxes).  Industry average for field-services is 18-25%;
// we use the low end for the optimistic scenario only.
const BENEFITS_BURDEN_RATE = 0.15;

// Capacity uplift: freed labor hours let the company take more orders.
// We assume they can fill 40-60% of freed hours with new work (not 100%
// — demand isn't infinite and ramp-up takes time).
const LOW_CAPACITY_FILL_RATE  = 0.0;   // conservative: no extra orders
const HIGH_CAPACITY_FILL_RATE = 0.50;  // optimistic:  fill half of freed hours

export function estimateAutomationImpact(process, totals) {
  if (!process) return null;

  // Try annualCost directly; if null/undefined, derive from component fields
  // (crew × people × hours × weeks × rate) as a fallback so the ROI card
  // still renders when grounding stripped annualCost but left the pieces.
  let laborCost = numOrNull(process.annualCost);
  if (laborCost === null) {
    const { crewCount, peoplePerCrew, hoursPerWeek, weeksPerYear, hourlyLaborCost } = process;
    const parts = [crewCount, peoplePerCrew, hoursPerWeek, weeksPerYear, hourlyLaborCost];
    if (parts.every((v) => typeof v === "number" && !isNaN(v))) {
      laborCost = Math.round(crewCount * peoplePerCrew * hoursPerWeek * weeksPerYear * hourlyLaborCost);
    }
  }
  if (laborCost === null) return null;

  const revenue       = numOrNull(totals?.revenue);
  const grossProfit   = numOrNull(totals?.grossProfit);
  const currentNetProfit = numOrNull(totals?.netProfit);
  const grossMarginPct   = numOrNull(totals?.grossMarginPct);
  // Effective gross margin as a decimal (e.g. 0.50)
  const grossMarginDec = grossMarginPct !== null ? grossMarginPct / 100
    : (revenue && grossProfit !== null) ? grossProfit / revenue
    : null;

  // ── LOW estimate (conservative) ──────────────────────────────────────
  const lowLaborSavings  = Math.round(laborCost * LOW_LABOR_DISPLACEMENT);
  const lowInsurance     = 0;  // conservative: don't count secondary benefits
  const lowCapacityRev   = 0;  // conservative: no extra orders
  const lowCapacityProfit = 0;
  const lowTotalSavings  = lowLaborSavings;

  // ── HIGH estimate (optimistic) ───────────────────────────────────────
  const highLaborSavings = Math.round(laborCost * HIGH_LABOR_DISPLACEMENT);
  const highInsurance    = Math.round(highLaborSavings * BENEFITS_BURDEN_RATE);

  // Capacity uplift: freed hours × fill rate → new revenue at gross margin
  // "How many more orders could you take?"  Use labor cost as a proxy for
  // hours freed (each $ of labor = some hours that can now serve new work).
  const highCapacityRev = grossMarginDec !== null
    ? Math.round(highLaborSavings * HIGH_CAPACITY_FILL_RATE / (grossMarginDec || 1))
    : 0;
  const highCapacityProfit = grossMarginDec !== null
    ? Math.round(highCapacityRev * grossMarginDec)
    : 0;
  const highTotalSavings = highLaborSavings + highInsurance + highCapacityProfit;

  // ── Projected net profit ─────────────────────────────────────────────
  const lowProjectedProfit  = currentNetProfit !== null ? currentNetProfit + lowTotalSavings  : null;
  const highProjectedProfit = currentNetProfit !== null ? currentNetProfit + highTotalSavings : null;
  const lowProjectedMarginPct  = lowProjectedProfit  !== null && revenue ? round1((lowProjectedProfit  / (revenue + lowCapacityRev))  * 100) : null;
  const highProjectedMarginPct = highProjectedProfit !== null && revenue ? round1((highProjectedProfit / (revenue + highCapacityRev)) * 100) : null;

  return {
    process: process.name || null,
    currentAnnualCost: laborCost,
    currentNetProfit,
    currentGrossMarginPct: grossMarginPct,

    low: {
      laborDisplacementRate: LOW_LABOR_DISPLACEMENT,
      laborSavings:   lowLaborSavings,
      insuranceSavings: lowInsurance,
      capacityRevenue: lowCapacityRev,
      capacityProfit:  lowCapacityProfit,
      totalAnnualBenefit: lowTotalSavings,
      projectedNetProfit:  lowProjectedProfit,
      projectedNetMarginPct: lowProjectedMarginPct,
    },
    high: {
      laborDisplacementRate: HIGH_LABOR_DISPLACEMENT,
      laborSavings:  highLaborSavings,
      insuranceSavings: highInsurance,
      capacityRevenue: highCapacityRev,
      capacityProfit:  highCapacityProfit,
      totalAnnualBenefit: highTotalSavings,
      projectedNetProfit:  highProjectedProfit,
      projectedNetMarginPct: highProjectedMarginPct,
    },

    note:
      "Low estimate: 55% labor displacement, no secondary benefits. " +
      "High estimate: 75% labor displacement + 15% insurance/benefits savings on displaced wages + " +
      "capacity uplift from freed hours (50% fill rate at current gross margin). " +
      "Actual savings depend on which robot is chosen and its running cost.",
  };
}

// All percentage math lives here, as a plain function, so Claude never has
// to compute a margin itself -- same rule convex/lib/roi.ts states for ROI.
// Prefers a stated grossProfit/netProfit line; falls back to deriving one
// from revenue/cogs/operatingExpenses when the sheet gives those instead.
export function computeMargins(totals) {
  const revenue = numOrNull(totals?.revenue);
  const cogs = numOrNull(totals?.cogs);
  let grossProfit = numOrNull(totals?.grossProfit);
  if (grossProfit === null && revenue !== null && cogs !== null) grossProfit = revenue - cogs;

  const operatingExpenses = numOrNull(totals?.operatingExpenses);
  let netProfit = numOrNull(totals?.netProfit);
  if (netProfit === null && grossProfit !== null && operatingExpenses !== null) {
    netProfit = grossProfit - operatingExpenses;
  }

  const grossMarginPct = revenue ? round1((grossProfit / revenue) * 100) : null;
  const netMarginPct = revenue && netProfit !== null ? round1((netProfit / revenue) * 100) : null;

  return {
    revenue,
    cogs,
    grossProfit,
    grossMarginPct: grossProfit !== null ? grossMarginPct : null,
    operatingExpenses,
    netProfit,
    netMarginPct: netProfit !== null ? netMarginPct : null,
  };
}

function cellToText(cell, maxChars) {
  if (cell === null || cell === undefined || cell === "") return "";
  let s = String(cell);
  if (s.length > maxChars) s = s.slice(0, maxChars) + "…";
  return s;
}

// Condenses parsed sheet rows (`[{ name, rows: [[cell, ...], ...] }]`) into a
// compact, pipe-separated text block for the prompt, capped on every axis so
// cost and latency stay bounded however large the uploaded workbook is.
export function summarizeSheets(sheets, opts = {}) {
  const maxSheets = opts.maxSheets ?? 6;
  const maxRows = opts.maxRows ?? 150;
  const maxCols = opts.maxCols ?? 20;
  const maxCellChars = opts.maxCellChars ?? 40;
  const maxTotalChars = opts.maxTotalChars ?? 60000;

  let anyTruncated = sheets.length > maxSheets;
  const blocks = sheets.slice(0, maxSheets).map((sheet) => {
    const rowsTruncated = sheet.rows.length > maxRows;
    const colsTruncated = sheet.rows.some((r) => r.length > maxCols);
    if (rowsTruncated || colsTruncated) anyTruncated = true;
    const lines = sheet.rows
      .slice(0, maxRows)
      .map((row) => row.slice(0, maxCols).map((cell) => cellToText(cell, maxCellChars)).join(" | "));
    return `=== Sheet: ${sheet.name} ===\n${lines.join("\n")}`;
  });

  let text = blocks.join("\n\n");
  if (text.length > maxTotalChars) {
    text = text.slice(0, maxTotalChars);
    anyTruncated = true;
  }
  if (anyTruncated) text += "\n…(truncated)";
  return { text, truncated: anyTruncated };
}

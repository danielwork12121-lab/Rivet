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

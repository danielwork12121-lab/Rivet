// Rivet Excel-financials analysis -- real Claude call, server-side only.
// The frontend (pages/find-solution.html, Excel Input tab) POSTs the
// operator's master spreadsheet as base64 ({ fileBase64, fileName }) here.
// We parse it with ExcelJS (api/lib/workbook.js), hand a condensed text copy of every sheet to
// Claude as a forced tool call, and ground every number it returns against
// numbers that literally appear in the sheet before any of it is trusted --
// Claude never totals, averages or computes a percentage itself; see
// api/lib/financials.js, the same rule convex/lib/roi.ts and convex/ai.ts
// state for the rest of Rivet's money math. Runs as a Vercel serverless
// function (Node.js runtime, auto-detected from this file's path under
// /api), same shape as api/chat.js and api/analyze-video.js.
//
// A real operator's own sheet is allowed to have a few mistakes -- a typo'd
// subtotal, a crew-cost line someone forgot to update. After grounding,
// every stated figure is also *reconciled* (api/lib/financials.js's
// reconcileTotals/reconcileProcess): checked against the other stated
// figures it should add up from, and replaced with the computed value when
// it doesn't. Every swap is logged in `extraction.corrections` and baked
// into a downloadable, corrected .xlsx (api/lib/corrected-workbook.js),
// which also carries a before/after net-profit projection for the
// recommended process (estimateAutomationImpact).
//
// Env var required: ANTHROPIC_API_KEY (same key api/chat.js uses -- set in
// Vercel -> Project Settings -> Environment Variables). Until it's set, this
// returns 500 and the Excel Input tab shows a clear error; the upload
// control still works either way.

import {
  computeMargins,
  estimateAutomationImpact,
  extractNumbers,
  groundFields,
  reconcileProcess,
  reconcileTotals,
  summarizeSheets,
} from "./lib/financials.js";
import { buildCorrectedWorkbook } from "./lib/corrected-workbook.js";
import { readWorkbookSheets } from "./lib/workbook.js";

// Sonnet 5.5 is the right pick here: fast enough to fit inside Vercel
// Hobby's hard 10-second function limit (Opus 5.5 regularly exceeds it),
// and more than accurate enough for spreadsheet transcription — every
// number it returns is grounded against the sheet anyway, so the model's
// job is reading comprehension, not reasoning.
const MODEL = "claude-sonnet-5-5";
// Vercel Hobby caps maxDuration at 10s regardless of vercel.json, so keep
// our own abort comfortably inside that to return a clean JSON error
// instead of Vercel's bare 504 HTML page.
const TIMEOUT_MS = 9000;
// Vercel's Node.js functions cap the request body at ~4.5MB; base64 inflates
// a file by about a third, so this leaves headroom for that plus the rest
// of the JSON envelope. The frontend enforces the same limit before upload.
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const EXTRACT_TOOL = {
  name: "extract_financials",
  description: "Record the financial totals and labor processes read from this operator's spreadsheet.",
  // Opus 5.5 (and Sonnet 5.5 / Fable 5.1 / Mythos 5.1) reject a forced
  // tool_choice ("tool"/"any") outright, so tool_choice below is "auto" and
  // this schema is enforced by the API instead via strict mode.
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      companyName: { anyOf: [{ type: "string" }, { type: "null" }] },
      currency: { type: "string", description: "ISO 4217 code; use USD if the sheet doesn't say" },
      totals: {
        type: "object",
        description:
          "Only figures the sheet actually states, for whatever period it covers (usually a year). " +
          "Leave a field null if the sheet doesn't state it -- never estimate, total, or calculate it yourself.",
        properties: {
          revenue: { anyOf: [{ type: "number" }, { type: "null" }] },
          cogs: { anyOf: [{ type: "number" }, { type: "null" }], description: "Cost of goods / cost of services sold" },
          grossProfit: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Only if the sheet states this line directly; otherwise null -- it will be derived for you",
          },
          operatingExpenses: { anyOf: [{ type: "number" }, { type: "null" }] },
          netProfit: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Only if the sheet states this line directly; otherwise null -- it will be derived for you",
          },
        },
        required: ["revenue", "cogs", "grossProfit", "operatingExpenses", "netProfit"],
        additionalProperties: false,
      },
      processes: {
        type: "array",
        description:
          "Distinct jobs or processes with their own visible labor cost -- a crew, a route, a recurring task. " +
          "List every one the sheet breaks out, even if some numbers for it are missing.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            annualCost: {
              anyOf: [{ type: "number" }, { type: "null" }],
              description: "What this process costs per year today, only if stated or directly readable as one sum in the sheet",
            },
            crewCount: { anyOf: [{ type: "number" }, { type: "null" }] },
            peoplePerCrew: { anyOf: [{ type: "number" }, { type: "null" }] },
            hoursPerWeek: { anyOf: [{ type: "number" }, { type: "null" }] },
            weeksPerYear: { anyOf: [{ type: "number" }, { type: "null" }] },
            hourlyLaborCost: { anyOf: [{ type: "number" }, { type: "null" }] },
            automationCandidate: {
              type: "boolean",
              description: "True if this is manual, repetitive, outdoor or field work a robot could plausibly take over",
            },
            note: { type: "string", description: "One short sentence of context; empty string if none" },
          },
          required: ["name", "automationCandidate"],
          additionalProperties: false,
        },
      },
      recommendedProcess: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Name of the single best automation candidate from `processes`, by cost and repetitiveness",
      },
      followUpQuestions: {
        type: "array",
        items: { type: "string" },
        description: "At most 3 short questions, only for numbers a robot ROI estimate needs that the sheet didn't state",
      },
      confidence: { type: "number", description: "0 to 1: how complete and legible the sheet was" },
    },
    required: ["totals", "processes", "followUpQuestions", "confidence"],
    additionalProperties: false,
  },
};

const PROMPT = `You are reading an operator's own master spreadsheet for Rivet, a
robotics-bounty marketplace for infrastructure, facilities, lawn-care and
pest-control operators. The sheets below were read directly out of their
workbook, one block per tab, as pipe-separated rows in reading order.

Call extract_financials exactly once. Use only numbers that literally appear
in the rows below -- never add, average, or otherwise calculate a number
yourself, and never invent a figure the sheet doesn't contain. If a field
isn't stated, leave it null: a downstream check discards any number you
return that can't be matched back to these rows, so a guess only costs
accuracy, never gains it. Read off every stated figure exactly as written,
even one that looks like it might be a mistake (a subtotal that looks off, a
crew cost that looks stale) -- a separate deterministic check reconciles
those against each other afterward, so your job is to transcribe accurately,
not to decide which figures look right. List every distinct job or crew that
has its own labor cost as a process, and mark the ones that look like
manual, repetitive, physical work a robot could plausibly take over.`;

function errorRes(res, status, error, detail) {
  return res.status(status).json(detail ? { error, detail } : { error });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return errorRes(res, 405, "Method not allowed");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorRes(res, 500, "ANTHROPIC_API_KEY not configured");
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return errorRes(res, 400, "Invalid JSON body");
    }
  }
  const fileBase64 = typeof body?.fileBase64 === "string" ? body.fileBase64 : "";
  const fileName = typeof body?.fileName === "string" && body.fileName ? body.fileName.slice(0, 200) : "spreadsheet";
  if (!fileBase64) {
    return errorRes(res, 400, "fileBase64 is required");
  }

  let buf;
  try {
    buf = Buffer.from(fileBase64, "base64");
  } catch {
    return errorRes(res, 400, "fileBase64 is not valid base64");
  }
  if (buf.length === 0) {
    return errorRes(res, 400, "Empty file");
  }
  if (buf.length > MAX_FILE_BYTES) {
    return errorRes(res, 413, "File is too large", `Max ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB`);
  }

  let sheets;
  try {
    sheets = (await readWorkbookSheets(buf, fileName)).filter((s) => s.rows.length > 0);
  } catch (err) {
    if (err?.code === "UNSUPPORTED_FORMAT") {
      return errorRes(res, 400, "That format isn't supported -- please re-export as .xlsx or .csv (legacy .xls isn't readable here)");
    }
    return errorRes(res, 400, "Could not read that file as a spreadsheet", String(err).slice(0, 300));
  }
  if (sheets.length === 0) {
    return errorRes(res, 400, "That spreadsheet looks empty");
  }

  // A real operator's workbook is rarely just a P&L tab -- a payroll
  // roster, a labor-burden buildup, an equipment list, a materials log, a
  // client-contract list, a job-estimate sheet, and the P&L itself is a
  // normal spread for one company. summarizeSheets' own default
  // (maxSheets: 6) is sized for a simple sheet, so raise it here rather
  // than silently dropping the tabs that usually carry the actual totals
  // (which tend to come *after* the supporting detail sheets, not before).
  const { text: sheetText } = summarizeSheets(sheets, { maxSheets: 16 });
  const groundSet = extractNumbers(sheetText);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: "medium" },
        system: PROMPT,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "auto" },
        messages: [
          {
            role: "user",
            content: `File: ${fileName}\n\n${sheetText}\n\nCall the extract_financials tool now with what you read above.`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return errorRes(res, 502, "Anthropic API error", errText.slice(0, 300));
    }

    const data = await r.json();
    const block = Array.isArray(data?.content) ? data.content.find((b) => b.type === "tool_use") : null;
    const raw = block?.input;
    if (!raw || typeof raw !== "object") {
      return errorRes(res, 502, "Model did not return structured output");
    }

    // Ground every numeric field against the sheet before any of it leaves this function.
    const totalPaths = ["totals.revenue", "totals.cogs", "totals.grossProfit", "totals.operatingExpenses", "totals.netProfit"];
    const { cleaned: groundedTotalsWrapper } = groundFields({ totals: raw.totals || {} }, totalPaths, groundSet);

    const processPaths = ["annualCost", "crewCount", "peoplePerCrew", "hoursPerWeek", "weeksPerYear", "hourlyLaborCost"];
    const rawProcesses = Array.isArray(raw.processes) ? raw.processes.slice(0, 12) : [];
    const groundedProcesses = rawProcesses.map((p, i) => {
      const { cleaned } = groundFields(p, processPaths, groundSet);
      return {
        ...cleaned,
        name: String(p?.name || `Process ${i + 1}`).slice(0, 200),
        note: String(p?.note || "").slice(0, 300),
        automationCandidate: !!p?.automationCandidate,
      };
    });

    // Grounded doesn't mean consistent -- a stated figure can still fail to
    // add up against the sheet's own other figures (a stale subtotal, a
    // crew-cost line nobody updated). Reconcile every stated figure against
    // what it should compute to, swap in the computed value where it
    // doesn't match, and keep a plain log of every swap.
    const { totals: reconciledTotalsInput, corrections: totalsCorrections } = reconcileTotals(groundedTotalsWrapper.totals);
    const totals = computeMargins(reconciledTotalsInput);

    const corrections = [...totalsCorrections];
    const reconciledProcesses = groundedProcesses.map((p) => {
      const { process, corrections: processCorrections } = reconcileProcess(p);
      corrections.push(...processCorrections);
      return process;
    });

    const recommendedProcessName =
      reconciledProcesses.find((p) => p.name === raw.recommendedProcess)?.name ||
      reconciledProcesses.find((p) => p.automationCandidate)?.name ||
      reconciledProcesses[0]?.name ||
      null;
    const recommendedProcess = reconciledProcesses.find((p) => p.name === recommendedProcessName) || null;
    const impact = estimateAutomationImpact(recommendedProcess, totals);

    const extraction = {
      companyName: typeof raw.companyName === "string" && raw.companyName ? raw.companyName.slice(0, 200) : null,
      currency: typeof raw.currency === "string" && raw.currency ? raw.currency.toUpperCase().slice(0, 3) : "USD",
      totals,
      processes: reconciledProcesses,
      recommendedProcess: recommendedProcessName,
      corrections,
      impact,
      followUpQuestions: Array.isArray(raw.followUpQuestions)
        ? raw.followUpQuestions.slice(0, 3).map((q) => String(q).slice(0, 300))
        : [],
      confidence: typeof raw.confidence === "number" && !isNaN(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      sheetsRead: sheets.map((s) => s.name),
    };

    let correctedWorkbookBase64 = null;
    try {
      const correctedBuf = await buildCorrectedWorkbook({ extraction, corrections, impact, sourceFileName: fileName });
      correctedWorkbookBase64 = correctedBuf.toString("base64");
    } catch {
      // Best-effort: the extraction itself is still fully usable without the
      // downloadable file, so a workbook-generation failure doesn't fail the request.
      correctedWorkbookBase64 = null;
    }

    return res.status(200).json({
      extraction,
      correctedWorkbook: correctedWorkbookBase64
        ? { fileBase64: correctedWorkbookBase64, fileName: `corrected-${fileName.replace(/\.(xlsx|csv)$/i, "")}.xlsx` }
        : null,
    });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return errorRes(res, timedOut ? 504 : 500, timedOut ? "Request timed out" : "Request failed");
  } finally {
    clearTimeout(timeout);
  }
}

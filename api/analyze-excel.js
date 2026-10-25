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
// Env var required: ANTHROPIC_API_KEY (same key api/chat.js uses -- set in
// Vercel -> Project Settings -> Environment Variables). Until it's set, this
// returns 500 and the Excel Input tab shows a clear error; the upload
// control still works either way.

import { computeMargins, extractNumbers, groundFields, summarizeSheets } from "./lib/financials.js";
import { readWorkbookSheets } from "./lib/workbook.js";

// Deep layer: careful reading of real financial figures, so this uses the
// same careful-judgment model convex/ai.ts's MODEL constant does, not the
// fast one api/chat.js uses for a one-line reply.
const MODEL = "claude-opus-5-5";
// Keep comfortably under vercel.json's maxDuration: 30 for this function, so
// we always get to return our own JSON error instead of a bare Vercel 504.
const TIMEOUT_MS = 25000;
// Vercel's Node.js functions cap the request body at ~4.5MB; base64 inflates
// a file by about a third, so this leaves headroom for that plus the rest
// of the JSON envelope. The frontend enforces the same limit before upload.
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const EXTRACT_TOOL = {
  name: "extract_financials",
  description: "Record the financial totals and labor processes read from this operator's spreadsheet.",
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
accuracy, never gains it. List every distinct job or crew that has its own
labor cost as a process, and mark the ones that look like manual, repetitive,
physical work a robot could plausibly take over.`;

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

  const { text: sheetText } = summarizeSheets(sheets);
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
        tool_choice: { type: "tool", name: "extract_financials" },
        messages: [{ role: "user", content: `File: ${fileName}\n\n${sheetText}` }],
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

    const totals = computeMargins(groundedTotalsWrapper.totals);
    const recommendedProcess =
      groundedProcesses.find((p) => p.name === raw.recommendedProcess)?.name ||
      groundedProcesses.find((p) => p.automationCandidate)?.name ||
      groundedProcesses[0]?.name ||
      null;

    const extraction = {
      companyName: typeof raw.companyName === "string" && raw.companyName ? raw.companyName.slice(0, 200) : null,
      currency: typeof raw.currency === "string" && raw.currency ? raw.currency.toUpperCase().slice(0, 3) : "USD",
      totals,
      processes: groundedProcesses,
      recommendedProcess,
      followUpQuestions: Array.isArray(raw.followUpQuestions)
        ? raw.followUpQuestions.slice(0, 3).map((q) => String(q).slice(0, 300))
        : [],
      confidence: typeof raw.confidence === "number" && !isNaN(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      sheetsRead: sheets.map((s) => s.name),
    };

    return res.status(200).json({ extraction });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return errorRes(res, timedOut ? 504 : 500, timedOut ? "Request timed out" : "Request failed");
  } finally {
    clearTimeout(timeout);
  }
}

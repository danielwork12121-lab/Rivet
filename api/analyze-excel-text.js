// Rivet Excel-financials analysis -- lightweight text-only endpoint.
// The frontend parses the spreadsheet client-side with SheetJS, runs
// summarizeSheets-equivalent logic in the browser, and POSTs only the
// pipe-separated text summary here ({ sheetText, fileName, sheetsRead }).
// This eliminates the Vercel body-size limit as a constraint on upload
// size -- a 200MB workbook produces the same ~60KB text summary as a 2MB
// one.  Same Claude call, grounding, reconciliation and corrected-workbook
// pipeline as analyze-excel.js.

import {
  computeMargins,
  estimateAutomationImpact,
  extractNumbers,
  groundFields,
  reconcileProcess,
  reconcileTotals,
} from "./lib/financials.js";

const MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 9000;
const MAX_TEXT_BYTES = 200 * 1024; // 200KB -- far more than summarizeSheets ever produces

const EXTRACT_TOOL = {
  name: "extract_financials",
  description: "Record the financial totals and labor processes read from this operator's spreadsheet.",
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

  const sheetText = typeof body?.sheetText === "string" ? body.sheetText : "";
  const fileName = typeof body?.fileName === "string" && body.fileName ? body.fileName.slice(0, 200) : "spreadsheet";
  const sheetsRead = Array.isArray(body?.sheetsRead) ? body.sheetsRead.map((s) => String(s).slice(0, 100)) : [];

  if (!sheetText) {
    return errorRes(res, 400, "sheetText is required");
  }
  if (Buffer.byteLength(sheetText, "utf8") > MAX_TEXT_BYTES) {
    return errorRes(res, 413, "Sheet text is too large", `Max ${Math.round(MAX_TEXT_BYTES / 1024)}KB`);
  }

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
      sheetsRead: sheetsRead.length > 0 ? sheetsRead : ["Sheet1"],
    };

    // No corrected workbook for the text endpoint -- the client didn't send the
    // binary file, so we can't rebuild it.  The extraction itself is the value.
    return res.status(200).json({
      extraction,
      correctedWorkbook: null,
    });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return errorRes(res, timedOut ? 504 : 500, timedOut ? "Request timed out" : "Request failed");
  } finally {
    clearTimeout(timeout);
  }
}

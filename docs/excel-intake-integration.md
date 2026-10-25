# Excel financials ⇄ Claude

`pages/find-solution.html`'s assistant panel has three tabs: **Chat**, **Video Input**,
and **Excel Input**. This doc covers the third one. It follows the same shape as
[`docs/intake-integration.md`](./intake-integration.md) (Chat) and the Video Input tab
described in [`api/analyze-video.js`](../api/analyze-video.js)'s own header comment.

## What it does

The operator uploads their own master spreadsheet — revenue, COGS, margins, crew hours,
whatever one tab or several say about the business — instead of typing numbers in by hand.
The page sends the raw file to `/api/analyze-excel`, which:

1. Parses every sheet with ExcelJS (`api/lib/workbook.js`) into plain row arrays.
2. Condenses those rows into a compact, capped text block (`api/lib/financials.js`'s
   `summarizeSheets`) so the prompt stays small and cheap however big the workbook is.
3. Sends that text to Claude as a single forced tool call (`extract_financials`), asking it
   to read off — never calculate — revenue, cost of goods sold, operating expenses, net
   profit (when the sheet states them directly), and every distinct job/crew with its own
   labor cost, flagging which ones look like automation candidates.
4. **Grounds every number Claude returns** against numbers that literally appear in the
   sheet (`extractNumbers` / `groundFields`); anything that can't be matched back to the
   source is dropped to `null` rather than trusted. This is the same rule
   `convex/lib/roi.ts` and `convex/ai.ts` already state for the rest of Rivet's money math —
   Claude extracts facts, plain functions do every calculation.
5. **Reconciles every grounded figure against the others it should add up from**
   (`reconcileTotals` / `reconcileProcess`) — a real operator's sheet is allowed to have a
   few mistakes (a stale subtotal, a crew-cost line nobody updated). Revenue − COGS should
   equal gross profit; gross profit − operating expenses should equal net profit; crew
   count × people/crew × hours/week × weeks/year × hourly rate should equal a process's
   annual cost. When a *stated* figure doesn't check out, the computed figure replaces it
   and the swap is recorded in `extraction.corrections` (`{ field, original, corrected,
   reason }`) — the sheet is never trusted blindly, but it's not thrown out for one bad
   cell either.
6. Derives gross/net margin percentages itself (`computeMargins`) from the reconciled
   totals, rather than trusting a percentage Claude computed.
7. Projects a before/after net-profit number for the recommended process
   (`estimateAutomationImpact`), assuming a robot could take over about 70% of that
   process's annual labor cost — the same assumption `pages/find-solution.html`'s own
   sample robot matching already uses elsewhere in the app.
8. Builds a downloadable, corrected `.xlsx` (`api/lib/corrected-workbook.js`): the
   reconciled P&L, the reconciled process list, the robot-impact projection, and a plain
   Corrections Log sheet — and returns it to the client as base64 alongside the
   extraction, so the operator can see and keep exactly what was fixed.

The page then shows the extracted totals, the recommended process, and any corrections,
and feeds the recommended process straight into the **same** manual-entry fields (`fJob`,
`fPeople`, `fHours`, `fHourly`, `fWeeks`, `formOn`) the Video Input tab already uses — so
matching and the sample ROI math downstream are unchanged. Uploading a sheet is just a
third way to fill those fields. A "Download corrected Excel" action on the tab turns the
returned base64 back into a file the operator can save.

## Request/response

`POST /api/analyze-excel`
```json
{ "fileBase64": "<base64-encoded .xlsx or .csv bytes>", "fileName": "financials.xlsx" }
```
→
```json
{
  "extraction": {
    "companyName": "string | null",
    "currency": "USD",
    "totals": { "revenue": 0, "cogs": 0, "grossProfit": 0, "grossMarginPct": 0, "operatingExpenses": 0, "netProfit": 0, "netMarginPct": 0 },
    "processes": [
      { "name": "string", "annualCost": 0, "crewCount": 0, "peoplePerCrew": 0, "hoursPerWeek": 0, "weeksPerYear": 0, "hourlyLaborCost": 0, "automationCandidate": true, "note": "string" }
    ],
    "recommendedProcess": "string | null",
    "corrections": [
      { "field": "totals.grossProfit", "original": 350000, "corrected": 400000, "reason": "string" }
    ],
    "impact": {
      "process": "string | null", "currentAnnualCost": 0, "savingsRateAssumed": 0.7, "estimatedAnnualSavings": 0,
      "currentNetProfit": 0, "projectedNetProfit": 0, "projectedNetMarginPct": 0, "note": "string"
    },
    "followUpQuestions": ["string"],
    "confidence": 0.8,
    "sheetsRead": ["P&L", "Jobs"]
  },
  "correctedWorkbook": { "fileBase64": "<base64 .xlsx>", "fileName": "corrected-financials.xlsx" }
}
```
Any `totals`/`processes` field is `null` when the sheet didn't state it, or when Claude's
answer didn't ground against the sheet, or when it was dropped during reconciliation (see
`corrections` for why). `impact` is `null` when there's no recommended process with a
grounded annual cost to project from. `correctedWorkbook` is `null` only if the workbook
itself failed to build — the extraction above is still fully usable without it. Errors
follow the same `{ "error": "...", "detail"?: "..." }` shape as `/api/chat` and
`/api/analyze-video`.

## Formats

**.xlsx and .csv only.** Legacy **.xls is not supported** — the request comes back with a
400 asking the operator to re-export. This was a deliberate trade-off: the obvious library
choice, SheetJS's `xlsx` package, has an unpatched high-severity prototype-pollution
advisory on the last version published to npm ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)),
and this route parses files anyone hitting the endpoint can upload. ExcelJS doesn't read
the old binary `.xls` format at all, so that coverage was dropped rather than taking that
risk on an endpoint that's exposed to arbitrary uploads. `api/lib/workbook.js`'s header
comment has the detail if this trade-off needs revisiting.

Client-side cap is 3MB (enforced again server-side): Vercel's Node.js functions cap the
whole request body around 4.5MB, and base64 inflates a file by about a third.

## Run it locally

This is a Vercel function, not a Convex action, so it needs `ANTHROPIC_API_KEY` set the
same way `api/chat.js` already does: Vercel → Project Settings → Environment Variables
(same key, already set if Chat works in prod). Locally, run `vercel env pull` once to get
a `.env.local` Vercel's CLI reads, then `vercel dev` to serve the whole `pages/` + `api/`
tree together with that key loaded. Without the key, the tab's upload control still works;
analysis just returns a clear "unavailable" error, same as Chat and Video Input do.

## Tests

`npm test` covers the parsing and math as plain unit tests, independent of any live API key:
- `api/lib/financials.test.ts` — number extraction, groundedness, margin derivation,
  reconciliation (`reconcileTotals`/`reconcileProcess`), the robot-impact projection, and
  sheet summarization.
- `api/lib/workbook.test.ts` — reads a real in-memory `.xlsx` (built and round-tripped with
  ExcelJS in the test itself) and a `.csv`, and rejects anything that's neither.
- `api/lib/corrected-workbook.test.ts` — builds a corrected workbook from a sample
  extraction and reads it back with ExcelJS, checking the P&L, process list, impact
  projection and corrections log all land on the sheet correctly.

`node scripts/check-frontend.mjs` syntax-checks `pages/find-solution.html`'s scripts
(including the Excel Input tab's) the same way it already checks Chat and Video Input.

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
5. Derives gross/net margin percentages itself (`computeMargins`) from whatever totals
   survived grounding, rather than trusting a percentage Claude computed.

The page then shows the extracted totals and the recommended process, and feeds that
process straight into the **same** manual-entry fields (`fJob`, `fPeople`, `fHours`,
`fHourly`, `fWeeks`, `formOn`) the Video Input tab already uses — so matching and the
sample ROI math downstream are unchanged. Uploading a sheet is just a third way to fill
those fields.

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
    "followUpQuestions": ["string"],
    "confidence": 0.8,
    "sheetsRead": ["P&L", "Jobs"]
  }
}
```
Any `totals`/`processes` field is `null` when the sheet didn't state it, or when Claude's
answer didn't ground against the sheet. Errors follow the same `{ "error": "...", "detail"?: "..." }`
shape as `/api/chat` and `/api/analyze-video`.

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
- `api/lib/financials.test.ts` — number extraction, groundedness, margin derivation, sheet
  summarization.
- `api/lib/workbook.test.ts` — reads a real in-memory `.xlsx` (built and round-tripped with
  ExcelJS in the test itself) and a `.csv`, and rejects anything that's neither.

`node scripts/check-frontend.mjs` syntax-checks `pages/find-solution.html`'s scripts
(including the Excel Input tab's) the same way it already checks Chat and Video Input.

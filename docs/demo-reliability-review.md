# Demo reliability & robotics-matching review (Cal Hacks 13.0 judging)

This is the closing report for the Cal Hacks 13.0 "Critical Demo Reliability and Robotics
Matching Improvements" review. It covers root causes, every file changed, the catalog records
added, the matching/financial-model fixes, the six mandatory regression tests (A–F), and what's
still a known limitation. All work landed on the `demo-reliability-fixes` branch; nothing was
pushed or merged until the full test suite, typecheck and frontend-compile check were clean.

## 1. Root causes

**Bug 1 — unrealistic recommendations / inflated ROI (the Mammotion LUBA case).**
`convex/lib/extract.ts`'s `robotFromPage()` defaulted a robot's `automationShare` to **0.5** (50%
of the *entire* task's annual cost) whenever a vendor page didn't state a labor-saved percentage.
`convex/lib/roi.ts`'s `computeRoi()` multiplies that share straight through
(`yearlyLaborSaved = currentAnnualCost * automationShare`) with no fleet-sizing or capacity check,
and `convex/lib/score.ts`'s evidence term never distinguished a guessed share from a vendor-stated
one. A cheap robot with no stated engineering requirements could therefore score a perfect
100/100 with an implausible ROI story, exactly as reported ($1,799 mower, ~$94k/yr "savings",
~0-month payback, >26,000% 5-yr ROI).

**Bug 2 — indoor robot recommended for outdoor work (the AGIBOT case).**
The `robots` schema already captured `environments: string[]` at extraction time, but
`convex/matching.ts`'s `toFacts()` never read it when building the facts the decision layer scores
against — it was write-only data. Robots were bucketed only by a loose free-text `task` string, with
no indoor/outdoor check at all.

Both the "rules" engine (`convex/matching.ts`) and the AI-driven "agent" engine
(`convex/agent.ts` → `convex/ai.ts`) call the same `rankRobots()`/`nextAction()` in
`convex/lib/decide.ts`, so fixing that shared decision layer fixes both flows without touching
`agent.ts`/`ai.ts`.

## 2. Files changed

| File | Change |
|---|---|
| `convex/lib/decide.ts` | New hard engineering-compatibility gate (`compatibilityOf`); new fleet-sizing caveat for large-scale jobs; wires `automationShareEstimated`/fleet-caveat into the evidence score and `roiConfidence`. |
| `convex/lib/score.ts` | Evidence formula optionally accounts for whether `automationShare` was vendor-sourced (backward-compatible: identical output when the new field is omitted). |
| `convex/lib/roi.ts` | Payback is never collapsed to "0 months" for a genuinely sub-1-month payback; shows one decimal place instead. |
| `convex/lib/extract.ts` | Conservative default `automationShare` lowered 0.5 → 0.15; added `automationShareEstimated` flag; kept the literal phrase "Assumed to replace" so the existing frontend caveat mechanism (see §5) still fires. |
| `convex/schema.ts` | Additive fields: `robots.automationShareEstimated`, `matchPick.compatibility`, `matchPick.roiConfidence`. |
| `convex/robots.ts` | Added `seedFlagshipDemo` (the three verified Section 3 products) and `backfillAutomationShareEstimated` (one-time migration flagging already-scraped robots whose share was guessed). |
| `convex/matching.ts` | `toFacts()` now reads `environments` and `automationShareEstimated` off the robot row — the direct fix for Bug 2. |
| `api/lib/financials.js` | `estimateAutomationImpact()` now returns `confidence: "hypothetical"`, a `limitations` list (including fleet-sizing), and `laborCostWasCorrected`; reworded `note` to lead with the hypothetical-not-verified framing. |
| `api/analyze-excel.js` | Passes `laborCostWasCorrected` through from the existing reconciliation step. |
| `pages/robot-finder.html` | Added "Engineering fit" / "ROI confidence" chips and a caveat paragraph on each pick card (Section 5). The only frontend file touched — chosen because it isn't the bundled 400KB `index.html`/`find-solution.html` blob. |
| `convex/lib/decide.test.ts`, `score.test.ts`, `roi.test.ts`, `extract.test.ts`, `robots.test.ts`, `matching.test.ts`, `api/lib/financials.test.ts` | New/expanded tests (see §6). |

**Deliberately not touched:** `pages/index.html` / `pages/find-solution.html` (the actual
flagship-demo pages). They're bundled, escaped 400KB single-line files, which makes a direct edit
high-risk for exactly the kind of "main push bug" this task was warned against. Instead, every
backend fix was written to stay compatible with their one existing safeguard: both pages contain
`p.assumptions.some(a => a.includes('Assumed to replace'))`, which greys out and caveats a pick's
savings/payback figures. Every new "this number is a guess" sentence this review adds — the lowered
`DEFAULT_AUTOMATION` default, the Husqvarna seed entry, and the new fleet-sizing caveat — was
written to contain that exact literal substring, so the existing frontend behavior now also covers
the new cases with zero frontend changes. Verified by a Python substring scan of both bundled files
confirming no other fragile text dependency exists, and that neither page references the new
`compatibility`/`roiConfidence` fields (so their absence breaks nothing there).

## 3. Catalog records added/updated (Section 3)

Three real, cited products seeded via `robots:seedFlagshipDemo` (idempotent by URL):

- **RC Mowers REAPER 52** — rcmowersusa.com/mowers/reaper/. Commercial remote-operated slope mower:
  50° slope, 1,000 ft range, 52" deck, ~2.5 acres/hr, for steep embankments/heavy brush — explicitly
  **not** residential. `priceStatus: "quote_only"` (no new-unit price on the page); the
  manufacturer's own ~$40k used-machine figure is recorded in `assumptions`, not used as the price.
- **Husqvarna Automower 435X AWD NERA** — husqvarna.com. Existing autonomous residential mower,
  AWD, listed at $2,999.99, 35° max slope. Flagged explicitly as **not** equivalent to a commercial
  brush cutter, and that its residential ~0.9-acre positioning isn't yet encoded as a hard area
  limit in the catalog.
- **RC Mowers RECONX** — rcmowersusa.com. Manufacturer-announced, spring-2027 production target.
  Deliberately seeded as `priceStatus: "quote_only"` (despite a real announced $39,986 price, which
  is recorded in `assumptions` only) so no payback/ROI figure is ever computed for it today, and its
  `provenance` states explicitly that it must never be treated as a currently-purchasable product or
  a community Idea Robot.

All three carry exact spec quotes + source URLs + a "manually verified on 2026-10-25" provenance
note, consistent with the codebase's existing provenance discipline (`dataSourceOf`,
`verifyEvidence`).

`robots:backfillAutomationShareEstimated` retroactively flags already-scraped robots (from before
this fix existed) whose `assumptions` text shows their automation share was guessed, not
vendor-stated — so the score-capping fix applies to data already in a live deployment, not only to
robots scraped after this change.

## 4. Matching logic changes (Section 2, P0)

- **Hard engineering compatibility gate** (`compatibilityOf` in `convex/lib/decide.ts`): classifies
  every robot as `compatible` / `conditionally_compatible` / `insufficient_info` / `incompatible`
  against the task's indoor/outdoor nature. `incompatible` robots are **excluded from the ranked
  list outright** — not merely scored low — so an indoor floor-cleaning robot can never appear for
  an outdoor vegetation/hazard task, and vice versa. A robot with no recorded environment, or a task
  the coarse keyword list can't place, is `insufficient_info` rather than a silent pass.
- **Evidence-aware scoring**: a guessed (not vendor-stated) `automationShare` now counts as missing
  evidence in `scoreParts()`, so a robot can no longer reach a perfect 100/100 on the strength of an
  unverified number.
- **Fleet-sizing caveat (Section 4, "don't assume one cheap robot replaces a crew")**: above a
  $150,000/yr task cost — a level that almost certainly means more than one worker or crew — the
  catalog has no "total area" or "crew count" field to check a robot's coverage spec against. Rather
  than inventing a fleet-count number, `rankRobots()` now treats the automation-share basis as
  unverified for that job's scale (demoting `roiConfidence` to `estimated` even for a vendor-sourced
  share) and appends an explicit caveat sentence to the pick's `assumptions`.
- **Payback never rounds to zero**: a genuinely sub-1-month payback now shows as e.g. `0.2` months
  instead of being misreported as instantaneous.

## 5. Financial-model corrections (Section 4)

- **Catalog ROI** (`convex/lib/roi.ts`, `decide.ts`): as above — conservative default automation
  share, payback-rounding fix, fleet-sizing caveat tied into `roiConfidence`.
- **Excel-upload ROI** (`api/lib/financials.js`'s `estimateAutomationImpact`): this is a separate,
  robot-agnostic estimator (a generic labor-displacement percentage applied to a process's labor
  cost — never tied to a specific robot's price/capability). It was not restructured into true
  fleet-sizing math (see §7), but now always returns `confidence: "hypothetical"` and a
  `limitations` list stating plainly that it doesn't check a specific robot's price, capability, or
  fleet size against the job — and flags when the labor cost behind the estimate had to be corrected
  (`laborCostWasCorrected`) because the sheet's own numbers didn't add up.
- **Summit Grounds-style workbook errors**: `reconcileTotals`/`reconcileProcess`
  (`api/lib/financials.js`) already corrected inconsistent totals/crew math *and reported every
  correction* rather than silently overwriting; `buildCorrectedWorkbook`
  (`api/lib/corrected-workbook.js`) already preserves the original value, the corrected value, and
  the reason in the workbook handed back to the operator. No change was needed here beyond wiring
  `laborCostWasCorrected` through — this machinery was already adequate.

## 6. Regression test results (Section 7)

All six are now explicit, labeled tests; full suite is 529/529 passing.

| Test | Scenario | Where | Result |
|---|---|---|---|
| **A** | Steep embankment / heavy brush | `convex/matching.test.ts` — *"Test A: a steep embankment/heavy-brush job rejects the residential mower on its mandatory slope requirement"*, run against the real seeded REAPER 52 vs. Husqvarna 435X | PASS — REAPER 52 (50°) meets a 45° mandatory slope requirement; Husqvarna (35°) is marked `misses`, never silently recommended. |
| **B** | Small residential lawn | `convex/matching.test.ts` — *"Test B: a small residential lawn gets a sane match..."* | PASS — a well-suited residential robot comes back `conditionally_compatible`, `roiConfidence: estimated`, score < 100 (never a fabricated perfect match), and the fleet-sizing caveat correctly does **not** fire for a genuinely small job. |
| **C** | Large commercial operation / fleet sizing | `convex/lib/decide.test.ts` (unit) + `convex/matching.test.ts` — *"Test C: ... even with a vendor-sourced automation share"* (end-to-end) | PASS — a $400k/yr job demotes `roiConfidence` to `estimated` and adds an explicit fleet-sizing caveat, even for a robot whose automation share **was** vendor-stated; no fleet count is ever invented. |
| **D** | Outdoor vegetation task vs. indoor robot | `convex/lib/decide.test.ts` (`compatibilityOf` unit tests) + `convex/matching.test.ts` — *"rejects an indoor-only robot from an outdoor task outright (Test D)"* | PASS — the indoor robot is excluded from the ranked list entirely, both directions (indoor-for-outdoor and outdoor-for-indoor). |
| **E** | Financial workbook with errors | `api/lib/financials.test.ts` (`reconcileTotals`/`reconcileProcess`) + `api/lib/corrected-workbook.test.ts` | PASS (pre-existing coverage, now explicitly labeled) — every inconsistent figure is corrected *and reported*, never silently overwritten; the corrected workbook preserves original + corrected + reason. |
| **F** | Missing robot costs/productivity | `convex/lib/decide.test.ts` — *"Test F: a robot with no price and no stated productivity specs never gets a fabricated ROI or fit"* | PASS — null payback/savings/break-even/lifetime, `unknown` (not `meets`) fit status, score capped below 100. |

Also re-verified clean throughout: `npm run typecheck` (0 errors) and
`node scripts/check-frontend.mjs` (all 12 pages' embedded scripts still compile), run after every
change block.

## 7. Remaining uncertainties / known limitations

- **True fleet-sizing math is not implemented.** The `Intent` type has no "total area" or "crew
  count" field, so there's no way to compute an actual number of units needed from a robot's
  `coverage_sqft_per_hour` spec. Per the spec's own fallback ("else don't assume one cheap robot
  replaces a crew"), this is handled by flagging the uncertainty in words (§4) rather than inventing
  a number — but a real fix would add a job-size field to intake and do the arithmetic.
- **The Excel-upload ROI estimator stays a generic percentage model.** It now honestly labels
  itself `hypothetical` with stated limitations, but wasn't restructured to separate
  total/process/automatable-subtask/avoidable labor costs or do robot-specific capacity math — that
  would be a larger, riskier change than this review's time allowed for with the same level of
  confidence.
- **The indoor/outdoor gate is coarse keyword matching** (`OUTDOOR_TASK_WORDS`/`INDOOR_TASK_WORDS`
  in `decide.ts`). It catches the clear cases (the AGIBOT bug) but a task phrased ambiguously falls
  through to `insufficient_info` rather than a confident classification — correct per the "never
  silently pass" rule, but it means some genuinely-fine matches will show a caveat they don't
  strictly need.
- **The $150,000 fleet-sizing threshold is a documented heuristic, not a computed boundary** — it's
  a round number chosen to be clearly above small-residential scale and clearly below it is
  commercial-scale, not derived from catalog data.
- **Browser/e2e scripts** (`npm run e2e:*`) were not re-run — they need a live Convex deployment and
  Clerk auth and are outside what this review's unit/integration suite covers. Everything else
  (`npm test`, `npm run typecheck`, `npm run check:frontend`) was run clean after every change.

## 8. Status

All changes are on the `demo-reliability-fixes` branch. 529/529 tests passing, typecheck clean,
all 12 pages' embedded scripts still compile. The visually risky bundled demo pages
(`pages/index.html`, `pages/find-solution.html`) were not edited at all.

# Robot matching (deterministic, owner-only, with saved requirements)

`matching:findRobots({ requestId, task, annualTaskCost?, requirements? })` ranks the catalog's robots for
one of the signed-in Client's own requests and saves the top three under that request (`matches` table,
one row per request, replaced on each run). `matching:latestMatch({ requestId })` returns it to the owner.
Both go through `loadOwnedDraft`: only the owning Client, never another account, a Developer, or a
signed-out caller. No clientToken argument exists.

- **Logic:** `convex/lib/decide.ts` (plain code: requirement fit, score, ROI, next action), `specs.ts`
  (units), `roi.ts`. These files are copied unchanged from `origin/feature/smart-agent-actor`.
- **No AI, no network, no cost:** nothing is scheduled, no key is needed, no AI budget is spent. Claude
  reasons, web search, Apify and scraping are not part of this phase.
- **Requirements:** the Client may pass them. Otherwise the saved "slope" follow-up answer becomes a
  non-mandatory requirement, noted as illustrative.
- **Provenance** (`dataSource` on every pick): `fictional_sample` (made-up demo robots, with a "not vendor
  data" note), `vendor_sourced` (read from a vendor page: has `fetchedAt` and spec quotes with source URLs),
  `unverified` (anything else, e.g. imported without a source). Quote-only prices are `null`, get no ROI,
  and count as "unknown" against a budget.

## Saved requirements (phase 3)

What to match is saved on the request so the page need not resend it:
`operatorRequests.matchingInput = { task, requirements?, updatedAt }` (annual cost stays in the existing
`cost.currentAnnualCost`). Each requirement has `basis`: `estimate` (the Client's own rough figure) or
`measured` (a figure the Client says they measured). Rivet verifies neither; they only change the notes shown.
The verified side is the robots' vendor-page specs (`fitSources`: `vendor_spec`, `sample_figure` or `unknown`).

- `matching:saveRequirements({ requestId, task, requirements, annualTaskCost? })`: validates everything
  first, then saves. If the input changed and a result exists, the result is recomputed on the spot, so a
  stale one is never shown. Identical input (any order) changes nothing. Returns `{ changed, matchUpdated, matchId }`.
- `matching:savedRequirements({ requestId })`: the saved input (`requirements: null` = derived from the slope answer).
- `matching:findRobots({ requestId, task?, annualTaskCost?, requirements? })`: with only `requestId` it uses
  the saved input. Anything passed is saved first. Old callers that always sent `task` keep working.
- `matching:latestMatch`: adds `stale` (the request changed elsewhere since the result: a new annual cost
  or follow-up answer; run matching again), `requirementBases` and per-pick `fitSources`.
- `matching:clearRequirements({ requestId })`: forgets the saved custom requirements so matching derives them
  from the follow-up answers again. The task and annual cost stay. An existing result is recomputed on the
  spot. Clearing twice (or with nothing custom saved) changes nothing. An empty saved list counts as saved:
  `requirements: []` means "none, on purpose", while `null` means "derived".
- `matching:overview({ requestId })`: `{ saved, match, state }` in one read, with `saved` and `match`
  exactly as `savedRequirements` and `latestMatch` return them. `state` is `no_result`, `stale` (inputs
  changed since the last run: run matching again) or `current`.
- All of them are owner-only (`loadOwnedDraft`). Bad input is rejected before anything is written.

## Workflow breakdown (Find a solution page)

`agent:planWorkflow` splits the Client's job into 3 to 7 steps with the fast model (one unit of AI
budget), stores them in the `workflows` table, and starts one match for each of the biggest steps a
robot might do (at most 3; never "needs a person" steps). Each step's match is preset with the
step's search phrase and its share of the job's yearly labor, so `ai.matchRobots` skips its read.

- `agent:latestWorkflow` returns every step with a verdict decided in code (`lib/workflow.ts`):
  `today` (a robot fits), `possible` (bounty candidate), `person`, `checking`, `unchecked`, `failed`,
  plus each step's robots and the combined yearly savings.
- `agent:setStepShare` (a slider) and `agent:setWorkflowLabor` re-rank in plain code: no AI, no budget.
- `agent:checkStep` searches a step that wasn't searched up front (one unit of budget).
- Robot photos (`robots.imageUrl`) come from the vendor page only: a photo link in the page text,
  else its Product JSON-LD image or `og:image` (`lib/images.ts`).

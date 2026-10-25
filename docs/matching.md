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

## Match score, lifetime value and pooled bounties

All plain code; Claude never computes these.

- **Match score** (`convex/lib/score.ts`), 0 to 100: `S = F × (0.4 C + 0.3 R + 0.3 E)`.
  F is 1 only if the robot meets every must-have. C is cost fit (payback: instant = 1, 5 years or
  never = 0; without a payback, price against budget; unknown price = 0.5). R is the share of
  requirements met. E is the share of judged figures (each requirement's spec, and the price) read
  from the vendor's page with a quote; fictional sample robots get 0. Robots are ranked by S; ties
  and zero scores fall back to the old closeness points so bounty gaps stay the fewest.
- **Lifetime value** (`convex/lib/roi.ts` `lifetimeValue`): over 5 years at an 8% discount rate,
  `NPV = −C0 + Σ (B − O)/(1 + r)^t`, `TCO = C0 + N·O`, `ROI = (N(B − O) − C0)/C0`. Stored on each
  pick as `lifetime` and shown on the page as one plain sentence.
- **Pooled bounties** (`convex/lib/pool.ts`): `B_k = Σ pledged` over posted, shared bounties with
  the same `taskKey`. `bounties:pooledDemand` gives a Client the totals for their steps' tasks
  (counts and money only, no names); the Developer board shows `pooledBusinesses` / `pooledPledged`.

The Find a solution page shows the breakdown as a map: the job, its steps (slider, verdict,
buttons), and what hangs off each step (robots with score and payback, a bounty with pooled
pledges, or why it wasn't searched).

## Work video (Gemini) in the breakdown

The Video Input tab still sends sampled frames to `/api/analyze-video` (Gemini, budgeted by
`aiBudget:reserveVideo`). When it finishes, the page saves the analysis text on the request with
`requests:setVideoNotes` (owner-only, trimmed: summary ≤ 600 chars, ≤ 12 items per list; frames and
boxes stay in the browser) before starting the breakdown. `agent:requestContext` passes it to
Claude as `videoObservations`; the breakdown uses its repeated actions to name and order steps
and marks those steps `seenInVideo` (shown as "In your video"). Numbers are checked against the
operator's own words only (`operatorText` in `ai.ts`), so a figure read from a video frame never
becomes a requirement or a cost.

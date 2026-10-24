# Robot matching (Phase 1: deterministic, owner-only)

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

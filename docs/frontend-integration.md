# Rivet backend — frontend integration contract

Backend: Convex + TypeScript. No server of our own: the browser talks to Convex directly.

## Connecting from plain HTML/JavaScript

You need one value from the backend owner: the **deployment URL**. For local
development it is `http://127.0.0.1:3210` (the backend owner must have
`npx convex dev` running on their machine, so it is reachable only from that
machine). A cloud deployment will look like `https://<name>.convex.cloud`. The URL is
public (not a secret). **Accounts**: every protected function needs a signed-in Clerk
session with the right role, and works only on the caller's own data. See
[accounts-and-access.md](accounts-and-access.md) for roles, sign-in and the full access table.
Fictional demo data only.

CORS needs no setup: Convex accepts browser requests from any origin, so
`file://`, `localhost` and any hosting all work.

```html
<script type="module">
  // Pin the version to match package.json.
  import { ConvexHttpClient } from "https://esm.sh/convex@1.48.0/browser";

  const client = new ConvexHttpClient("http://127.0.0.1:3210"); // or the cloud URL

  // client.setAuth(fetchClerkSessionToken) first: see js/rivet-api.js
  const clientToken = crypto.randomUUID(); // retry key: one per draft, so retries never duplicate
  const intake = {
    title: "Fictional Culvert Co. — inspection request",
    description: "Fictional: culverts need yearly inspection.",
    environment: "Confined, wet, no GPS, 0.8m diameter",
    constraints: ["Must be tethered"],
  };

  // Create once (retrying with the same token returns the same id)
  const id = await client.mutation("requests:create", { ...intake, clientToken });
  // Edit the same request later
  await client.mutation("requests:updateIntake", { id, ...intake, description: "Edited." });
  // Read it back (e.g. after a refresh)
  const draft = await client.query("requests:getDraft", { id });
</script>
```

`ConvexHttpClient` is request/response (call again to refresh). In this repo the page
uses the wrapper in `js/rivet-api.js` instead of calling these directly.

Functions are addressed by string `"<file>:<export>"`.

### Errors
Failed calls reject the promise. Validation failures from `requests:create` are a
`ConvexError` whose **`err.data`** is a user-readable string, e.g.
`"title must not be empty"`. Show that:

```js
try {
  await client.mutation("requests:create", form);
} catch (err) {
  showError(typeof err.data === "string" ? err.data : "Something went wrong, try again.");
}
```
Do not rely on `err.message`: on cloud deployments it is redacted. Wrong argument
types (e.g. `constraints` not an array) are rejected with a generic error and have no `err.data`.

### Rendering user text safely
Titles, descriptions and constraints are stored as the operator typed them and are
**not** HTML-escaped. Render them with `element.textContent = ...`, never `innerHTML`.

## Functions

Every public function, and what protects it:

| Function | Kind | Access |
|---|---|---|
| `requests:create`, `requests:listMine`, `requests:claimLegacyDraft` | mutation/query | signed-in Client |
| `requests:updateIntake`, `requests:saveFollowUps`, `requests:getDraft` | mutation/query | the owning Client |
| `bounties:post`, `bounties:getMine` | mutation/query | the owning Client |
| `bounties:listPosted` | query | approved Developer: public projection only |
| `agent:generateSpec`, `agent:answerQuestions`, `agent:recommend`, `agent:requestBounty` | mutation | the owning Client (each starts a paid Claude call) |
| `agent:latestSpec`, `agent:latestPicks`, `agent:latestBounty`, `agent:specStatus` | query | the owning Client |
| `users:me`, `users:ensureAccount`, `users:chooseRole`, `users:redeemDeveloperInvite` | query/mutation | see accounts-and-access.md |
| `agent:aiStatus` | query | open: `{ available }`, plus `reason` (`no_key`, `daily_limit`) and a safe `message` when unavailable |
| `aiBudget:reserveChat` | mutation | server only: requires `RIVET_SERVER_SECRET` and the visitor's Client session (called by Vercel's `/api/chat`) |
| `robots:search`, `robots:get` | query | open (fictional catalog, no private data) |

**Not public** (internal, backend/CLI only): `requests:get`, `requests:list`,
`ai:hello`, `ai:runEvals`, `robots:seed`, `maintenance:testData`, and every internal
agent/robots helper. Calling them from a
browser fails with "Could not find public function".

### Changes from the first version of this contract
| Before | Now | Why |
|---|---|---|
| `requests:get({ id })` public | `requests:getDraft({ id })` for the owner; `get` is internal | Anyone with an id could read the record, including its token |
| `requests:list` public | internal | Returned every operator, including "Stay anonymous" ones |
| Edits created a new request | `requests:updateIntake` edits the same record | One request per operator draft |
| Responses included `clientToken` | Never returned | It used to protect the draft |
| A draft was protected by its `clientToken` | It belongs to the signed-in Client account (`ownerId`); the token only makes retries safe | Tokens could be copied; accounts are verified by Clerk |

### `requests:create` (mutation)
| Arg | Type | Rules |
|---|---|---|
| `title` | string | required, trimmed, 1–120 chars |
| `description` | string | required, trimmed, 1–5000 |
| `environment` | string | required, trimmed, 1–2000 |
| `constraints` | string[] | required (may be `[]`), ≤20 items, each ≤500; blanks dropped |
| `cost` | object | optional |
| `cost.currency` | string | required if `cost` given; 3 letters (`"usd"` → `"USD"`) |
| `cost.currentAnnualCost` | number | optional, ≥0 |
| `cost.budget` | number | optional, ≥0 |
| `cost.notes` | string | optional, ≤1000 |
| `profile` | object | optional. See below |
| `clientToken` | string | optional, 8–100 chars of letters, digits, `-`, `_`. **Makes retries safe**: if this account already created a request with this token, its id is returned and nothing is inserted. Generate one per logical submission (`crypto.randomUUID()`) and reuse it when retrying the same submission |

`profile` fields: `companyName` (1–100), `businessType` (1–50, free text), `region` (1–50, free text),
`crewCount` (whole number 1–10000), `peoplePerCrew` (optional, whole number 1–10000),
`hourlyLaborCost` (>0, ≤10000), `visibility` (`"shared"` or `"anonymous"`).

Returns: the new request's id (string), owned by the signed-in Client. Without
`clientToken`, every call creates a new request.

### `requests:updateIntake` (mutation)
Args: `{ id, ...same fields as create (without clientToken) }`. Replaces the
step 1 fields of that draft; an omitted `cost`/`profile` is removed. Follow-up answers and
`status` are kept. Returns the id. Same validation as `create`.

### `requests:saveFollowUps` (mutation)
Args: `{ id, answers, complete }`. Replaces the whole answer set.
`complete` (boolean) is the client saying every question was answered. Send only questions
the user actually answered, never pre-filled defaults.

| `answers[]` field | Type | Meaning |
|---|---|---|
| `key` | string | Stable question id, e.g. `"slope"`. Letter first, then letters, digits, `-`, `_`; ≤50; unique |
| `question` | string | The text the user saw (1–500) |
| `answerLabel` | string | The option the user picked, verbatim (1–200). **This is the answer.** |
| `assumption` | object, optional | `{ value: number, unit?: string }`: the frontend's *illustrative* number for that option. Not a measurement or threshold. `unit` (1–30) is omitted when there is none |

At most 10 answers. An empty array clears saved answers.

### `requests:getDraft` (query)
Args: `{ id }`. Returns the caller's draft (shape below, without `clientToken` or `ownerId`).

### Draft errors
`getDraft`, `updateIntake` and `saveFollowUps` reject with `err.data === "Draft not found"`
for an unknown id **or** another account's request (deliberately indistinguishable). A malformed id
rejects with a generic error.

### Returned draft shape
```json
{
  "_id": "k17...",
  "_creationTime": 1760000000000,
  "title": "string",
  "description": "string",
  "environment": "string",
  "constraints": ["string"],
  "cost": { "currency": "USD", "currentAnnualCost": 40000, "budget": 25000, "notes": "optional" },
  "profile": { "companyName": "string", "businessType": "lawn", "region": "West", "crewCount": 3, "peoplePerCrew": 2, "hourlyLaborCost": 24, "visibility": "shared" },
  "followUps": [
    { "key": "slope", "question": "How many of your properties have slopes steeper than about 20°?", "answerLabel": "Some", "assumption": { "value": 20, "unit": "degrees" } },
    { "key": "obstacles", "question": "Are most sites wide open, ...?", "answerLabel": "Mixed", "assumption": { "value": 0.85 } }
  ],
  "followUpsComplete": false,
  "updatedAt": 1760000050000,
  "status": "submitted"
}
```
`cost`, `profile`, `followUps`, `followUpsComplete`, `updatedAt` and optional inner fields are
absent (not null) when not set.
`_creationTime` is milliseconds since the epoch. `status` is `"submitted"` or `"specified"`.

## Shared bounties

### `bounties:post` (mutation)
Args: `{ requestId, taskKey, title, specLines, gaps, note, industry, pledgePercent, pledged, goal }`.
Posts the operator's bounty for one task, or updates it if that request already posted for
that task, so retries never create a second bounty. Returns the bounty id.
Rejected for requests whose profile says `visibility: "anonymous"`.

| Arg | Rules |
|---|---|
| `taskKey` | the page's task id, e.g. `"mow"` (letter first; letters, digits, `-`, `_`; ≤30) |
| `title` | 1–160 |
| `specLines` | ≤12 lines, each 1–300: the spec exactly as the operator saw it |
| `gaps` | ≤10 chip labels, each 1–100 |
| `note` | ≤500, may be empty. **Stored raw**: escape when rendering |
| `industry` | 1–50 |
| `pledgePercent` | 0–100 |
| `pledged`, `goal` | USD, ≥0 and >0. **Illustrative demo figures, not commitments** |

### `bounties:getMine` (query)
Args: `{ requestId }`. The owner's posted bounties, newest first (full rows).

### `bounties:listPosted` (query)
Args: `{ limit?: number }` (default 50, 1–100). Posted bounties, newest first, as
`{ _id, _creationTime, title, taskKey, industry, region, specLines, goal, pledged }`.
No request id, owner, company name, token, gaps, note or AI drafts. Approved Developers only.
It is a live query: `RivetApi.watchPostedBounties(onData, onError)` subscribes, so newly posted
bounties appear without a refresh.

### Draft vs posted
The `bounties` table holds both. `status: "draft"` rows are AI-written briefs
(`agent:requestBounty`), visible only to the owner via `agent:latestBounty`.
`status: "posted"` rows come only from `bounties:post` and are the only ones on the board.

## For the AI teammate (agent functions)
The agent from `feature/agent` is merged with these changes:
- Every public `agent:*` function takes `{ requestId, ... }` and needs the signed-in Client that
  owns the request; anyone else gets `"Draft not found"`. `clientToken` is still accepted for
  older callers and ignored. Paid calls also count against a per-account daily limit.
- `agent:requestContext` strips `clientToken` and `ownerId` before the request is sent to Claude.
- `ai:hello` and `ai:runEvals` are internal: run them with `npx convex run ai:hello`.
- AI-written bounties are saved as private drafts (`status: "draft"`, `source: "ai"`).
- Failed runs (`spec`, `recommend`, `bounty`) are logged to `agentRuns` with `ok: false`.
- **Spec runs are jobs** (`aiJobs`): `queued` → `running` → `succeeded` | `failed`.
  - `agent:generateSpec({ requestId })` returns `{ jobId, reused }`. A queued or
    running job is reused, so repeated clicks never start a second paid call (a run stuck for
    over 10 minutes stops blocking). Without `ANTHROPIC_API_KEY` it rejects with
    `err.data = "AI drafting is unavailable: no Anthropic API key is configured on the backend."`
    and queues nothing.
  - `agent:specStatus({ requestId })` returns `{ available, unavailableReason,
    unavailableMessage, job, spec, stale, clarifications }`. `unavailableReason` is `no_key`,
    `daily_limit`, `request_limit` or `user_limit` (see the limits in docs/intake-integration.md). `job.errorKind` is `"unavailable"` (missing/rejected credentials) or
    `"model_error"`; `job.error` is safe to show. `stale` is true when the request (intake or
    follow-up answers) changed after the AI read it. `clarifications` are answers to the AI's
    own questions, separate from the fixed `followUps`.
  - Specs record `jobId`, `model`, and `requestVersion` (the request's `updatedAt`, else
    `_creationTime`, at the time the AI read it).
- The page has exactly one AI trigger: "Draft requirements with AI" on step 2. Opening the
  step only reads `agent:specStatus` / `agent:aiStatus`.
- `ANTHROPIC_API_KEY` belongs in Convex env vars (`npx convex env set`), never in files.
  Without it, AI actions fail and are logged; nothing else is affected.

## Robot catalog
Convex is the canonical catalog (`robots`, all `sample: true`). `robots:seed` (internal, run
`npx convex run robots:seed`) adds any missing sample robots and never overwrites:
the agent's 5 sample robots and the page's 9 sample products. Page products carry
`sampleKey` (`"p1"`..`"p9"`, the page's product id), `taskKey` (the page's task id),
`slopeLimitDeg`, `regions`, `trl` and a `provenance` note; every number is illustrative.
`robots:search({ task?, maxPrice? })` and `robots:get({ id })` are public reads.


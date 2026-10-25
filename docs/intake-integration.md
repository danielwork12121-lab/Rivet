# Intake and follow-ups ⇄ Convex

> The old prototype page `pages/robot-bounty-client-flow.html` was removed on 2026-10-25; clients use Find a solution (`/`). The notes below are kept for history.

`pages/robot-bounty-client-flow.html` (served by Vercel at `/robot-bounty-client-flow`) keeps
the signed-in Client's request in Convex (signed-out visitors are sent to log in; see
[accounts-and-access.md](accounts-and-access.md)). Step 1
creates it the first time; later step 1 saves update the same record; step 2 adds the
follow-up answers to it. Glue code is in [`js/rivet-api.js`](../js/rivet-api.js); the page's
own additions are marked `RIVET-BACKEND`.

## When the page saves
| Action | Backend call |
|---|---|
| Step 1 **Continue**, or a stepper jump forward from step 1 | first time `requests:create`, afterwards `requests:updateIntake` (only if something changed) |
| Step 2 **See automation opportunities**, or a stepper jump forward from step 2 | `requests:saveFollowUps` (only if at least one answer was picked and something changed) |
| Page load | `users:ensureAccount`, then (Clients) `requests:claimLegacyDraft` once for a pre-accounts draft, then `requests:getDraft` for the request this browser was editing (`rivet.intake.current.<backend>`), else the newest from `requests:listMine`, and `bounties:getMine` |
| Step 5 **Post bounty** | `bounties:post` (after saving the intake if it changed, e.g. "Join the shared program") |
| Developer **Bounty board** shown | live subscription to `bounties:listPosted` (approved Developers only) |
| Page load | `robots:search`: the page's sample products come from Convex; the built-in `PRODUCTS` copy is only an offline fallback |
| Step 2 shown | `agent:specStatus` (or `agent:aiStatus` before step 1 is saved): status only |
| Step 2 **Draft requirements with AI** | saves changed answers, then `agent:generateSpec`, then polls `agent:specStatus` every 2 s (max 3 min) |

Moving backwards never saves. Leaving step 2 through **Back** does not save answers picked
since the last save.

## Field mapping, step 1
| Page state | Backend field | Notes |
|---|---|---|
| `S.describe` | `description` | Empty/whitespace is rejected (page shows a message first) |
| `S.name` | `profile.companyName` | |
| `S.type` | `profile.businessType` | `"lawn"` / `"pest"` |
| `S.region` | `profile.region` | |
| `S.crews` | `profile.crewCount` | |
| `S.perCrew` | `profile.peoplePerCrew` | lawn only |
| `S.wage` | `profile.hourlyLaborCost` | |
| `S.visibility` | `profile.visibility` | `"anon"` → `"anonymous"` |
| *(derived)* | `title` | `"<company> — <business label> automation request"` (form has no title field) |
| *(derived)* | `environment` | e.g. `"Lawn care operation, West region, 3 crews of 2 people."` |
| *(none)* | `constraints` | `[]`; step 1 has none |
| `crypto.randomUUID()` | `clientToken` | created once per draft; a retry key only (access comes from the account) |

## Field mapping, step 2
Only the first `S.answered` questions are sent. The page pre-fills `S.answers` with defaults
(20, 0.85, 32) that the user never chose; those are never saved.

| Saved field | Source | Example |
|---|---|---|
| `key` | `QUESTIONS[i].key` | `"slope"` |
| `question` | `QUESTIONS[i].q` | the text shown |
| `answerLabel` | the chip the user clicked | `"A lot of them"` |
| `assumption.value` | the number the page attaches to that chip | `28` |
| `assumption.unit` | fixed per key in `rivet-api.js` | `"degrees"`, `"weeks per year"`; **none** for `obstacles` |

`assumption` is the frontend's illustrative modelling input, not a measurement. The obstacle
value (1 / 0.85 / 0.7) is a unitless factor used by the page's sample ROI math.
On restore, answers are matched by `answerLabel`, so renaming an option means old answers to
that question are not restored.

## Behaviour
- **Success is shown only after Convex confirms** ("Request saved", "Changes saved", "Answers saved"),
  then the page advances.
- **Loading**: the button becomes disabled "Saving…"; clicks while saving are ignored.
- **Errors** (empty fields, backend validation, unreachable server, 15 s timeout) show in the existing
  red `.notice` box; the operator stays put and can retry. Retrying is safe: a repeated create returns
  the same id, and updates replace values rather than adding records.
- **Refresh** restores step 1 and the answers. A remembered request that isn't yours (or is gone) is
  forgotten and the newest of your own is opened instead. If the backend is unreachable, the page
  says it couldn't check your sign-in and offers a retry.
- **Bounty (step 5)**: **Post bounty** saves via `bounties:post`; the posted view appears only after
  Convex confirms. "Edit my pledge" re-posts and updates the same bounty. Refresh restores it.
- **Developer board** loads posted bounties when shown and labels every card: *sample*,
  *saved demo submission*, or *your saved demo submission*.
- **Sample vs saved money**: once a bounty is saved, its totals, backer count and Developer card
  show only the saved pledge; the page's sample backers stay listed as "not counted".
- **ROI screens** are illustrative: operator inputs combined with sample hours per task and
  sample robot data, labelled as such. Unanswered assumptions are marked "default".
- **AI draft**: shown as "AI-generated draft · not verified", with the model and the AI's own
  questions (separate from the fixed follow-ups); flagged when the request changed since.
  Without an API key the panel says AI is unavailable and nothing is sent anywhere.
- **Not saved yet**: search filters, vendor contacts, invites, and the Developer profile, claim,
  milestones and delivery.

## Which backend the page uses
`js/rivet-config.js` decides, by one fixed rule, and the page shows it ("Saved to Rivet (cloud)"):

| Page opened from | Backend |
|---|---|
| `localhost`, `127.0.0.1`, or a `file://` page | `local`: `http://127.0.0.1:3210` (`npx convex dev` with a local deployment) |
| any other host, e.g. `rivet-rose.vercel.app` | `cloud`: `https://coordinated-canary-9.convex.cloud` |
| any page with `?backend=local` or `?backend=cloud` | that one (explicit override for testing) |

Each backend keeps its own saved draft in the browser, so environments never mix.

## Run it locally (fictional data only)
```sh
# terminal 1: backend (leave running); .env.local decides local vs cloud deployment
npx convex dev

# terminal 2: serve the site on loopback only
python3 -m http.server 8080 --bind 127.0.0.1
# open http://127.0.0.1:8080/pages/robot-bounty-client-flow.html
# add ?backend=cloud to use the Convex Cloud dev deployment from your machine
```
It imports the Convex client from `https://esm.sh/convex@1.48.0/browser` (pinned), so it needs
internet access.

## Checks
```sh
npm run typecheck
npm test               # backend, page logic, config and /api/chat unit tests (no network)
npm run check:frontend # every page's scripts compile and JSON data blocks parse
RIVET_TARGET=cloud npm run e2e:local    # live API checks (or RIVET_TARGET=local)
RIVET_TARGET=cloud npm run e2e:browser  # real Chrome, both roles, two browser sessions
```
`RIVET_TARGET` is required and must match the deployment in `.env.local`; the scripts refuse to
mix backends. They never press the AI button while AI is available (no paid calls). They leave
fictional rows (company names starting `E2E-TEST `) on the target backend.

## Before a demo
```sh
npx convex run robots:seed          # once: adds the sample catalog (never overwrites)
npm run test-data:list              # read-only: test requests, their rows, and unmatched requests
npx convex run maintenance:testData '{"action":"delete","confirm":"delete-test-data"}'
```
Delete removes only requests matching the test markers it lists, plus their bounties, specs,
picks, clarifications and AI jobs. Unmatched requests are never touched.

## AI (optional) and its limits
Set the key on the backend only, never in files: `npx convex env set ANTHROPIC_API_KEY ...`.
Every paid AI call (spec drafting, recommendations, bounty briefs, the website chat) is checked
against server-side daily limits first (`convex/lib/aiBudget.ts`), counted over the last 24 hours:

| Convex env var | Default | Limits |
|---|---|---|
| `AI_DAILY_LIMIT` | 25 | all paid AI calls together: the hard budget cap |
| `AI_REQUEST_DAILY_LIMIT` | 3 | spec/recommend/bounty runs per operator request |
| `AI_CLIENT_DAILY_LIMIT` | 10 | website chat calls per visitor (keyed hash of the IP) |

Unset means the default; any value that isn't a whole number >= 0 means 0 (AI off). Set
`AI_DAILY_LIMIT=0` to switch all paid AI off instantly. The page shows the server's reason when AI
is unavailable.

## Website chat (`api/chat.js`, Vercel)
Off unless all of these are set in Vercel: `CHAT_ENABLED=true`, `ANTHROPIC_API_KEY`,
`CONVEX_URL` (the cloud URL above) and `RIVET_SERVER_SECRET`; the same `RIVET_SERVER_SECRET` must
be set in Convex (`npx convex env set RIVET_SERVER_SECRET ...`). Before each call it reserves budget
in Convex (`aiBudget:reserveChat`); anything wrong means no call and an explicit error
(`unavailable` / `limit` / `failed` / `timeout`), never a made-up reply.

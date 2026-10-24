# Intake and follow-ups ⇄ Convex

`Robot Bounty Client Flow.html` keeps **one draft request per browser** in Convex. Step 1
creates it the first time; later step 1 saves update the same record; step 2 adds the
follow-up answers to it. Glue code is in [`js/rivet-api.js`](../js/rivet-api.js); the page's
own additions are marked `RIVET-BACKEND`.

## When the page saves
| Action | Backend call |
|---|---|
| Step 1 **Continue**, or a stepper jump forward from step 1 | first time `requests:create`, afterwards `requests:updateIntake` (only if something changed) |
| Step 2 **See automation opportunities**, or a stepper jump forward from step 2 | `requests:saveFollowUps` (only if at least one answer was picked and something changed) |
| Page load | `requests:getDraft` with the id + token from `localStorage` (`rivet.intake.draft`) |

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
| `crypto.randomUUID()` | `clientToken` | created once per draft; required for every later read or edit |

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
- **Refresh** restores step 1 and the answers. A stored draft whose token is rejected (or whose record
  is gone) is forgotten. If the backend is unreachable the blank form is shown and the draft is kept.
- **Not saved yet**: steps 3–5 (filters, vendor contacts, bounty, pledge) and the whole Developer side.

## Run it locally (fictional data only)
```sh
# terminal 1: backend (leave running)
npx convex dev

# terminal 2: serve the page on loopback only
python3 -m http.server 8080 --bind 127.0.0.1
# open http://127.0.0.1:8080/Robot%20Bounty%20Client%20Flow.html
```
Opening the HTML file directly also works. The page uses `http://127.0.0.1:3210` unless
`window.RIVET_CONVEX_URL` is set before `js/rivet-api.js` loads. It imports the Convex client from
`https://esm.sh/convex@1.48.0/browser` (pinned), so it needs internet access.

To start over as a new operator, clear the site's storage (DevTools → Application → Local storage →
delete `rivet.intake.draft`).

**Network exposure:** the local backend binds to all interfaces (`*:3210`). On the backend owner's Mac,
incoming connections for `convex-local-backend` are denied in the macOS firewall; keep it that way, use
fictional data only, and do not tunnel or deploy it publicly.

## Checks
```sh
npm run typecheck
npm test               # backend + client-module unit tests
npm run check:frontend # every page's scripts compile, alone and together
npm run e2e:local      # needs `npx convex dev`; live API checks incl. token rejection
npm run e2e:browser    # needs `npx convex dev` and Google Chrome; full Client + Developer journey
```
`e2e:local` and `e2e:browser` leave fictional rows in the local dev database.

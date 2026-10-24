# Intake screen ⇄ Convex

`Robot Bounty Client Flow.html` saves the step 1 intake to Convex when the operator presses
**Continue to follow-ups** (or clicks a later step in the stepper). Glue code is in
[`js/rivet-api.js`](../js/rivet-api.js); the page only calls `RivetApi.*`.

## Field mapping (step 1 → `requests:create`)
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
| `crypto.randomUUID()` | `clientToken` | one per distinct form content; reused on retry |

## NOT saved yet
Everything after step 1: the three follow-up answers (`S.answers.slope`, `.obstacles`, `.weeks`),
search filters, vendor contacts, the bounty (gaps, note, pledge %) and "posted". The backend has no
update function for these yet. The `.obstacles` value is a frontend modelling multiplier (1 / 0.85 / 0.7);
agree with the AI/engine owners how it should be stored before persisting it.

## Behaviour
- **Success is shown only after Convex returns an id** ("Request saved" toast, then advance).
- **Loading**: the button becomes disabled "Saving…"; clicks while saving are ignored.
- **Errors** (empty fields, backend validation, unreachable server, 15 s timeout) show in the existing
  red `.notice` box under the form; the operator stays on step 1 and can retry safely.
- **Refresh**: the saved id is kept in `localStorage` (`rivet.intake.requestId`). On load the page calls
  `requests:get` and refills the form; "Saved to Rivet · ref xxxxxx" confirms it. If the id no longer exists
  it is forgotten. If the backend is unreachable the blank form is shown and the id is kept.
- **Unchanged form → Continue**: no new request. **Edited form → Continue**: a *new* request is created
  (no update function yet), so editing after saving leaves the earlier request behind.
- The page does **not** call `requests:list`: it returns every operator's data regardless of the
  "Stay anonymous" choice.

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
`https://esm.sh/convex@1.48.0/browser` (pinned), so it needs internet access; vendoring is a later option.

**Network exposure:** the local backend listens on all interfaces (`*:3210`) and has no authentication.
Use a network you trust and fictional data only, and do not tunnel or deploy it publicly.

## Checks
```sh
npm run typecheck
npm test              # backend + client-module unit tests
npm run e2e:local     # needs `npx convex dev` running; leaves fictional rows in the dev DB
```

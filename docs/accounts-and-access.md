# Accounts and access

Clerk signs people in. Convex decides what they may do. The browser never decides access.

## How it fits together

1. A page loads `js/rivet-config.js` (Convex URL, Clerk publishable key), `js/rivet-auth.js`
   (Clerk's browser SDK, loaded from this instance's Frontend API) and `js/rivet-api.js`.
2. The person signs up or logs in with the existing `pages/signup.html` / `pages/login.html`
   forms. Clerk stores the password, emails the verification and reset codes, and keeps the
   session (refresh, expiry, sign-out in other tabs).
3. `js/rivet-api.js` connects to Convex over a WebSocket and gives it the person's Clerk session
   token. Convex verifies it against `convex/auth.config.ts` (issuer `CLERK_FRONTEND_API_URL`,
   audience `convex`) and asks for a new token when the old one expires. On sign-out or a
   session change, it closes the socket (see "Known behaviour" below).
4. Every protected Convex function looks up the caller's row in the `users` table
   (`convex/lib/auth.ts`) and checks its role there.

## Roles

| Role | How you get it | What it allows |
|---|---|---|
| Client | Choose "I need a robot for a job" at sign-up | Create and edit **your own** requests, follow-ups and bounties; start paid AI on your own requests; use the website chat |
| Developer (pending) | Choose "I build robots" at sign-up | Nothing Developer-only yet: sample bounties only |
| Developer (approved) | An admin approves you, or you redeem an invite code | Read the live bounty board (`bounties:listPosted`) |

- The role is chosen **once** (`users:chooseRole`) and stored in Convex. It can't be changed
  from a browser, so a Client can never make itself a Developer. Changing it takes an admin.
- Roles never come from email domains, URL parameters, localStorage or anything else the
  browser sends.
- Claims, milestones, messages and payments are **demo only**. They are simulated in the page,
  are not saved, and the pages say so.

### Admin (Convex CLI only)

```sh
npx convex run users:list '{"developerStatus":"pending"}'
npx convex run users:setDeveloperStatus '{"clerkUserId":"user_...","status":"approved"}'   # or "revoked"
npx convex run users:createDeveloperInvite '{"note":"Bayline Robotics","days":7}'       # prints a single-use code once
```

Only a SHA-256 hash of each invite code is stored.

## Requests that existed before accounts

Rows created by the old token-only API have no `ownerId`, and no browser can reach them. They
are not deleted. If a browser still remembers such a draft (`rivet.intake.draft.<backend>` in
localStorage), the client-flow page calls `requests:claimLegacyDraft` once after a Client signs
in. That moves the draft (and its bounties) into that account and forgets the token. A draft that
already has an owner can't be claimed by anyone else.

## Public Convex functions

| Function | Who may call it |
|---|---|
| `users:me` | anyone (says whether you're signed in, and your own account) |
| `users:ensureAccount`, `users:chooseRole`, `users:redeemDeveloperInvite` | signed in |
| `requests:create`, `requests:listMine`, `requests:claimLegacyDraft` | Client |
| `requests:getDraft`, `updateIntake`, `saveFollowUps` | the owning Client |
| `bounties:post`, `bounties:getMine` | the owning Client |
| `bounties:listPosted` | approved Developer (a live query: subscribe with `RivetApi.watchPostedBounties`) |
| `agent:*` except `aiStatus` | the owning Client (`clientToken` is still accepted, for older callers, and ignored) |
| `agent:aiStatus`, `robots:search`, `robots:get` | anyone (no private data) |
| `aiBudget:reserveChat`, `aiBudget:reserveVideo` | server only: need `RIVET_SERVER_SECRET` **and** a forwarded Client session |

Refusals are `ConvexError`s whose `err.data` is one of: `"Please sign in to continue."`,
`"Finish setting up your account first."`, `"This needs a Client account."`,
`"This needs an approved Developer account."`, or `"Draft not found"` (unknown id, or not yours:
deliberately the same message).

## Paid AI

- Convex AI functions need the owning Client and are capped per request, per account
  (`AI_USER_DAILY_LIMIT`, default 10) and globally (`AI_DAILY_LIMIT`, default 25) per 24 hours.
- `/api/chat` (Vercel) answers only requests that carry a Clerk session token
  (`Authorization: Bearer …`). It forwards the token to Convex (`aiBudget:reserveChat`), which
  verifies it, requires a Client account and spends one unit of budget **before** Claude is called.
  No token: 401. Developer: 403. Over a limit: 429. Chat is also off unless `CHAT_ENABLED=true`.
- `/api/analyze-video` (Gemini) works the same way through `aiBudget:reserveVideo` and is off unless
  `VIDEO_ENABLED=true`. It validates frames first (JPEG/PNG/WebP data URLs, at most 8, ~450 KB each,
  ~1.9 MB total) so bad requests never spend budget, keeps the Gemini key in a header, and never
  returns Gemini's error text. A video analysis also counts toward the all-kinds daily limits.

## Configuration

| Where | Name | Value |
|---|---|---|
| Convex (each deployment) | `CLERK_FRONTEND_API_URL` | `https://relevant-kingfish-8271.clerk.accounts.dev` (Development instance). Deploying without it fails on purpose |
| Convex | `RIVET_SERVER_SECRET` | same random value as Vercel's, if chat is used |
| Vercel | `CHAT_ENABLED`, `ANTHROPIC_API_KEY`, `CONVEX_URL`, `RIVET_SERVER_SECRET` | see `api/chat.js` |
| Vercel | `VIDEO_ENABLED`, `GEMINI_API_KEY`, `CONVEX_URL`, `RIVET_SERVER_SECRET` | see `api/analyze-video.js`; off unless `VIDEO_ENABLED=true` |
| Convex | `VIDEO_DAILY_LIMIT` (10), `VIDEO_USER_DAILY_LIMIT` (3) | video analyses per 24 h, overall and per account |
| `js/rivet-config.js` | Clerk publishable key | public by design |
| Clerk Dashboard | Convex integration | enabled (session tokens carry `aud: "convex"`) |

## Testing locally without real Clerk users

`scripts/local-auth-issuer.mjs` is a local stand-in for Clerk's token issuer. A **local**
deployment's `CLERK_FRONTEND_API_URL` points at it, so Convex really verifies the signed test
tokens. Never point a shared deployment at it.

```sh
node scripts/local-auth-issuer.mjs                                      # terminal 1
CONVEX_AGENT_MODE=anonymous npx convex dev                              # terminal 2: a local deployment
npx convex env set CLERK_FRONTEND_API_URL http://127.0.0.1:8790         # local deployment only
npx convex env set RIVET_SERVER_SECRET local-test-secret-not-real
npx convex run robots:seed
npm run e2e:auth                   # accounts, roles, ownership, live board, token expiry, /api/chat
npm run e2e:auth:browser           # the real pages in Chrome
RIVET_TARGET=local npm run e2e:local
RIVET_TARGET=local npm run e2e:browser
```

The browser suites replace clerk-js with `scripts/fake-clerk.mjs`. They prove the pages, the
wiring and Convex's checks. They do **not** prove real Clerk behaviour: sign-up, email delivery,
the new-device (Device Trust) code, password reset and real session expiry still need checking
against the Clerk Development instance.

## Testing against real Clerk

`npm run e2e:clerk` (run as `HEADED=1 npm run e2e:clerk`) drives the real pages in Chrome with
real clerk-js and the Clerk Development instance, against an isolated Convex Cloud dev deployment
named in `.env.local` (it refuses `coordinated-canary-9` and anything that isn't a cloud dev
deployment). It creates two fictional users with `+clerk_test` emails (Clerk accepts the fixed
code `424242` for those and sends no mail) and makes no AI calls. Delete the `rivet.e2e.*`
users in the Clerk Dashboard afterwards.

- It needs a normal (windowed) Chrome. This instance has **Clerk Protect** on; its bot check
  ("Verifying your request") never finishes in headless Chrome, so sign-up stalls there.
- Sign-in and sign-up use Clerk's **Future API** (`__internal_future`) and load the **`@clerk/ui`**
  bundle, because only that path resolves Protect challenges. With the older `client.signUp`
  methods, sign-up ends in the missing requirement `protect_check`.
- Real session tokens last 60 seconds, have `aud: "convex"`, and carry **no email or name**
  unless you add them under Sessions → Customize session token in the Clerk Dashboard. Without
  that, `users:list` shows only the Clerk user id (plus the name and organization the person
  typed), so approve Developers by checking that id in the Clerk Dashboard.

## Known behaviour

- With convex 1.48, a WebSocket client kept acting as the previous user after
  `setAuth(() => null)` and after `clearAuth()` (checked against a local backend in
  `npm run e2e:auth`). So `js/rivet-api.js` closes the socket on sign-out or a session change, and
  the next call opens a fresh one.
- The login page's "Keep me logged in" box is cosmetic. Session length is a Clerk instance
  setting.

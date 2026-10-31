# Hosting

Runbook for the production setup. Secret values never go into chat, commits or screenshots; set them
in the Vercel or Convex dashboards or CLIs only.

## Who owns what

| Piece | Where | Details |
| --- | --- | --- |
| Frontend + `/api` | Vercel project `rivet`, team `danielwork12121-labs-projects` | Production tracks branch `main`. Live at https://rivet-rose.vercel.app |
| Backend | Convex team `rivet-hq`, project `rivet` | Production: `agreeable-bobcat-49` (https://agreeable-bobcat-49.convex.cloud). Dev: `industrious-ox-314` (`dev/daniel-li`, no env vars set yet) |
| Auth | Clerk Development instance `relevant-kingfish-8271` | Not in Daniel's Clerk account, see the TODO below |

Production used to track the branch `website-merged`, which is why pushes to `main` never went live.
It now tracks `main`: a push to `main` deploys the frontend. Other branches get Previews.

The old backend `woozy-warbler-733` was a hackathon teammate's dev deployment in the Convex team
"Rivet". It is no longer used.

## Deploying

**Frontend:** push to `main`. Vercel builds Production. Changed env vars only apply to a new
deployment, so redeploy after changing them.

**Backend:** from a clone of `main`, with a logged-in CLI:

```
npx convex login          # once
npm install
npx convex deploy -y      # deploys to the production deployment
```

Deploy the backend whenever `convex/` changes, before or together with the frontend that calls it.
The deploy also installs the cron.

## Environment variables (names only)

**Convex production** (`npx convex env set NAME value --prod`, or Dashboard, Settings, Environment Variables):

| Name | Notes |
| --- | --- |
| `CLERK_FRONTEND_API_URL` | Issuer of the Clerk instance |
| `RIVET_SERVER_SECRET` | Must equal the Vercel value |
| `ANTHROPIC_API_KEY` | Claude key |
| `AI_MATCH_ENABLED` | `true` |
| `DISCOVERY_ENABLED` | `false` (no Apify token) |
| `AI_DAILY_LIMIT`, `AI_USER_DAILY_LIMIT`, `AI_REQUEST_DAILY_LIMIT` | 200 / 50 / 10 |
| `VIDEO_DAILY_LIMIT`, `VIDEO_USER_DAILY_LIMIT` | 50 / 10 |
| `DISCOVERY_DAILY_LIMIT`, `DISCOVERY_USER_DAILY_LIMIT` | 0 / 0 |

A limit that isn't a whole number counts as 0, which turns that feature off. Values are trimmed
server-side (`api/lib/env.js`, `convex/lib/env.ts`), so stray whitespace from pasting no longer
breaks the gates.

**Vercel** (`npx vercel env add NAME production`):

| Name | Notes |
| --- | --- |
| `CONVEX_URL` | The production deployment URL above |
| `RIVET_SERVER_SECRET` | Must equal the Convex value |
| `ANTHROPIC_API_KEY` | Chat and the Excel tab |
| `GEMINI_API_KEY` | Video input |
| `CHAT_ENABLED` | `true` |
| `VIDEO_ENABLED` | `true` |

## Seeding the catalog

```
npx convex run --prod robots:seed              # 14 sample robots
npx convex run --prod robots:seedFlagshipDemo  # 3 real robots
```

## Known TODO: Clerk

The app uses a Development Clerk instance (`relevant-kingfish-8271`; publishable key in
`js/rivet-config.js`) that is not in Daniel's Clerk account. After the YC deadline:

1. Create your own Clerk application.
2. Swap the publishable key in `js/rivet-config.js`.
3. Set `CLERK_FRONTEND_API_URL` on Convex production, then redeploy both sides.

## Self-healing

`convex/crons.ts` runs `sweep:sweepStuck` every 5 minutes using the `by_status` indexes, ending
searches, matches and breakdowns that are stuck so the page shows a result or "try again" instead of
spinning. It used to run every 2 minutes with full table scans.

## Troubleshooting

- **503 "unavailable"** from `/api` or a feature: an env gate is closed. Check the matching flag
  (`CHAT_ENABLED`, `VIDEO_ENABLED`, `AI_MATCH_ENABLED`, `DISCOVERY_ENABLED`), that
  `RIVET_SERVER_SECRET` is identical on Vercel and Convex, that the API key is set, and that the daily
  limit is not 0. Redeploy Vercel after changing its variables.
- **Web search skipped**: `DISCOVERY_ENABLED=false` and its limits are 0 by design until an Apify
  token is added.
- **Pushes don't go live**: confirm Vercel Production tracks `main` (Settings, Git).
- **Convex over-limit warnings**: the free plan's database I/O was exceeded by the old 2-minute
  full-scan sweeper. The 5-minute `by_status` version fixed it; if the warning returns, look for new
  full scans or tight polling before upgrading the plan.
- **Page errors about missing functions**: the frontend is ahead of the backend; run
  `npx convex deploy -y`.

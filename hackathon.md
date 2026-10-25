# Hackathon log

- **Project:** Rivet
- **Event:** Cal Hacks 13.0
- **What it does:** Rivet lets a small trade business describe a job, ranks robots that could do it with the payback worked out in code, and pools bounties for robots that don't exist yet.
- **Live app:** https://rivet-rose.vercel.app
- **Repo:** https://github.com/danielwork12121-lab/Rivet
- **Frontend:** Vercel
- **Convex deployment:** https://woozy-warbler-733.convex.cloud (a development deployment, as returned by the live app's /api/config)
- **Components:** none
- **Convex features:** schema (15 tables, 22 indexes), queries, mutations, internal actions, scheduled functions, cron jobs, realtime subscriptions (ConvexClient.onUpdate, no React useQuery), Clerk auth via ctx.auth
- **Auth:** Clerk
- **AI models:** claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5, gemini-3.8-flash
- **Started:** 2026-10-24T02:30:51Z
- **Last updated:** 2026-10-25T06:59:03Z

## How we use Convex

- **Developer bounty board** is the one screen that updates live without a refresh: `bounties:listPosted` is subscribed with `ConvexClient.onUpdate` (js/rivet-api.js, pages/engineers.html). Find a solution and Robot Finder poll.
- **Private, account-owned requests**: Convex verifies Clerk tokens, and owner-only functions check the caller via `ctx.auth` and the `by_owner` index (convex/lib/auth.ts, convex/requests.ts).
- **Robot matching and saved requirements**: `matching:findRobots` ranks by code and saves the result; `overview` reads it back (convex/matching.ts, convex/schema.ts).
- **Job breakdown and web search**: mutations queue internal actions with the scheduler; the page polls for progress (convex/agent.ts, convex/ai.ts).
- **Stuck-work sweeper**: a cron runs every 2 minutes (convex/crons.ts, convex/sweep.ts).
- **Spend limits**: serializable mutations count usage before any paid call (convex/lib/aiBudget.ts).

## Log

- 2026-10-24 `c2b33ee` Convex and TypeScript scaffold.
- 2026-10-24 `49ad3dd` Request schema and functions (convex/schema.ts, requests.ts).
- 2026-10-24 `516ea33` Claude agent: spec, robot picks (convex/agent.ts, ai.ts).
- 2026-10-24 `2bd4bb5` Posted bounties (convex/bounties.ts).
- 2026-10-24 `1075bc2` Server-side daily AI limits (convex/aiBudget.ts).
- 2026-10-24 `cc73b32` Clerk sign-in, roles, owned requests (convex/auth.config.ts).
- 2026-10-24 `f833ae1` Apify robot finder (convex/discovery.ts).
- 2026-10-24 `e6e3ce3` Owner-only matching (convex/matching.ts).
- 2026-10-25 `d5347bb` clearRequirements and overview (convex/matching.ts).
- 2026-10-25 `195f036` Key kept out of Apify input (convex/scrape.ts, lib/apify.ts).
- 2026-10-25 `770465c` Job breakdown (convex/agent.ts, ai.ts).
- 2026-10-25 `72a7613` Score, 5-year value, pooled bounties (convex/lib/score.ts, pool.ts).
- 2026-10-25 `79b133f` Sweeper cron (convex/crons.ts, sweep.ts).

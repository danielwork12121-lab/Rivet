# Deploying feature/agent-refinements

For whoever holds the keys. Keys go into the Vercel and Convex prompts or dashboards only, never
into chat, commits or screenshots.

## 1. Pick what you're deploying

Vercel builds **Production from `main`** and a **Preview for every other branch**. This work is on
`feature/agent-refinements`, so either:

- **Demo from the preview**: every push to the branch rebuilds
  `rivet-git-feature-agent-re-…vercel.app` (the link is in the Vercel dashboard under
  Deployments). Preview has its own environment variables, so set them for **Preview** too (step 3).
- **Make it production**: merge `feature/agent-refinements` into `main`. It already contains all
  of `main`, so the merge has no conflicts.

## 2. Deploy the Convex backend that matches the site

The page calls new functions (`agent:planWorkflow`, `agent:latestWorkflow`, `requests:setVideoNotes`,
`bounties:pooledDemand`…). If the Convex deployment the site points at runs older code, the page
shows errors. From a clone of this branch:

```
git checkout feature/agent-refinements && git pull
npm install
npx convex deploy          # the deployment Vercel's CONVEX_URL points at
```

The schema change is additive (new optional fields and a `workflows` table), so existing data stays
valid.

## 3. Environment variables

**Convex** (`npx convex env set NAME value`, or the Convex dashboard → Settings → Environment Variables):

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude key |
| `AI_MATCH_ENABLED` | `true` |
| `DISCOVERY_ENABLED` | `true` |
| `APIFY_TOKEN` | Apify token |
| `APIFY_ACTOR_ID` | `unselfish_kingsnake~robot-spec-finder`, or your own copy (see below) |
| `CLERK_FRONTEND_API_URL` | `https://relevant-kingfish-8271.clerk.accounts.dev` |
| `RIVET_SERVER_SECRET` | a long random value, **the same as on Vercel** |
| `DISCOVERY_DAILY_LIMIT`, `DISCOVERY_USER_DAILY_LIMIT` | defaults are 3 and 1 a day; use e.g. `100` for the demo |
| `AI_DAILY_LIMIT`, `AI_USER_DAILY_LIMIT`, `AI_REQUEST_DAILY_LIMIT` | defaults 25 / 10 / 3; raise for the demo |
| `VIDEO_DAILY_LIMIT`, `VIDEO_USER_DAILY_LIMIT` | defaults 10 / 3 |

A limit that isn't a whole number counts as 0, which turns that feature off.

**Vercel** (`npx vercel env add NAME production`, and again with `preview` if you demo from the preview):

| Name | Value |
| --- | --- |
| `CONVEX_URL` | `https://<deployment>.convex.cloud` of the backend from step 2 |
| `RIVET_SERVER_SECRET` | same value as Convex |
| `CHAT_ENABLED` | `true` |
| `ANTHROPIC_API_KEY` | Claude key (chat and the Excel tab) |
| `VIDEO_ENABLED` | `true` |
| `GEMINI_API_KEY` | from aistudio.google.com/apikey |

Vercel only applies changed variables to a **new** deployment: redeploy after setting them.

## 4. The Apify Actor

`APIFY_ACTOR_ID` must be an Actor the `APIFY_TOKEN` account can run. If the token belongs to a
different Apify account than `unselfish_kingsnake`, push your own copy and use its id:

```
cd apify/robot-spec-finder
npx apify-cli login          # with the token's account
npx apify-cli push --force
```

If the Actor can't start, the backend falls back to Apify's own Google search + crawler, so searches
still work but are slower. The free Apify plan runs 5 jobs at once; extra searches wait and retry.

## 5. Before the demo

- **Warm the catalog.** A fresh backend has no robots, so the first search for each task takes a few
  minutes. Run the demo jobs once beforehand (e.g. mowing, floor scrubbing); later searches for the
  same task are instant.
- **Test with a Client account**: chat → the job flow appears → robots with photos and scores →
  "Start a bounty" on a "Possible" step. Then Video Input with a short clip (steps tagged
  "In your video") and Excel Input.
- If a step says "Web search skipped", a daily limit or `DISCOVERY_ENABLED` is the cause; "Web search
  failed" shows Apify's error.

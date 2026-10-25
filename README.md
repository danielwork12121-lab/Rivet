# Rivet

## How we use Convex

- Convex holds every request, robot, match and bounty, with Clerk sign-in checked inside Convex functions.
- The Developer bounty board updates live through a `ConvexClient.onUpdate` subscription; other screens poll.
- Robot matching, spend limits and the stuck-work cron run as Convex mutations, scheduled internal actions and a cron job.
- Not used: components, HTTP actions, file storage, search or vector search.
- Full list with proof files and a dated log: [hackathon.md](hackathon.md).

Rivet — explainable robotics feasibility engine + pooled bounties for infrastructure operators. Cal Hacks 13.0.

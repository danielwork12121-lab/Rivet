import type { AuthConfig } from "convex/server";

// Clerk signs users in; Convex checks every request's Clerk session token against
// this provider (issuer + audience) before ctx.auth.getUserIdentity() returns anyone.
//
// The issuer is the Clerk Frontend API URL, set per deployment, never in a file:
//   npx convex env set CLERK_FRONTEND_API_URL https://relevant-kingfish-8271.clerk.accounts.dev
// Deploying without it fails, so a deployment can't silently run with no auth.
// "convex" is the audience Clerk's Convex integration puts in its tokens.
export default {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;

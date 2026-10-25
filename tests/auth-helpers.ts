// Signed-in callers for convex-test. withIdentity() stands in for a Clerk session
// token that Convex has already verified; these helpers then do what the pages do
// after sign-in (users:chooseRole), so tests start from a real account row.
import type { TestConvex } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import type schema from "../convex/schema";

type T = TestConvex<typeof schema>;
export const ISSUER = "https://relevant-kingfish-8271.clerk.accounts.dev";

export const identity = (sub: string, extra: Record<string, string> = {}) => ({
  issuer: ISSUER, subject: sub, tokenIdentifier: `${ISSUER}|${sub}`, ...extra,
});

// Signed in with Clerk, but no account row or role yet.
export const signedIn = (t: T, sub: string) => t.withIdentity(identity(sub));

export async function asClient(t: T, sub = "user_client_a") {
  const as = signedIn(t, sub);
  await as.mutation(api.users.chooseRole, { role: "client" });
  return as;
}

// A Developer account; approved by an admin unless `approved` is false.
export async function asDeveloper(t: T, sub = "user_dev_a", approved = true) {
  const as = signedIn(t, sub);
  await as.mutation(api.users.chooseRole, { role: "developer" });
  if (approved) await t.mutation(internal.users.setDeveloperStatus, { clerkUserId: sub, status: "approved" });
  return as;
}

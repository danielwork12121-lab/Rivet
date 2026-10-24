import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

// Access model (fictional demo, no accounts): whoever holds a request's
// `clientToken` owns that draft. Every public function that reads or changes
// anything belonging to a request must call loadOwnedDraft first.

// Same error for "no such id" and "wrong token", so ids can't be probed.
export const DRAFT_NOT_FOUND = "Draft not found";

export async function loadOwnedDraft(
  ctx: QueryCtx,
  id: Id<"operatorRequests">,
  clientToken: string,
): Promise<Doc<"operatorRequests">> {
  const doc = await ctx.db.get(id);
  if (!doc || doc.clientToken === undefined || doc.clientToken !== clientToken) {
    throw new ConvexError(DRAFT_NOT_FOUND);
  }
  return doc;
}

// A request without its token: the shape that may leave the database, whether
// to the owner's browser or to a third-party API.
export function withoutToken({ clientToken: _token, ...rest }: Doc<"operatorRequests">) {
  return rest;
}

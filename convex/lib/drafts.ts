import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireClient } from "./auth";

// Access model: a request belongs to the signed-in Client account in its ownerId
// (see lib/auth.ts). Every public function that reads or changes anything
// belonging to a request must call loadOwnedDraft first.

// Same error for "no such id" and "not yours", so ids can't be probed.
export const DRAFT_NOT_FOUND = "Draft not found";

export async function loadOwnedDraft(
  ctx: QueryCtx,
  id: Id<"operatorRequests">,
): Promise<Doc<"operatorRequests">> {
  const user = await requireClient(ctx);
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerId === undefined || doc.ownerId !== user._id) {
    throw new ConvexError(DRAFT_NOT_FOUND);
  }
  return doc;
}

// A request without its token or owner: the shape that may leave the database,
// whether to the owner's browser or to a third-party API.
export function withoutToken({ clientToken: _token, ownerId: _owner, ...rest }: Doc<"operatorRequests">) {
  return rest;
}

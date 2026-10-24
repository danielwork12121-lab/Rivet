import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const costInfo = v.object({
  currency: v.string(), // ISO 4217 code, normalised to upper case
  currentAnnualCost: v.optional(v.number()), // what the operator spends today
  budget: v.optional(v.number()), // what they'd pay for a solution
  notes: v.optional(v.string()),
});

// Who is asking and how their operation is staffed. Free-form strings for
// businessType/region on purpose: the frontend owns those vocabularies.
export const profileInfo = v.object({
  companyName: v.string(),
  businessType: v.string(),
  region: v.string(),
  crewCount: v.number(),
  peoplePerCrew: v.optional(v.number()),
  hourlyLaborCost: v.number(), // fully loaded, in the cost currency (USD in the demo)
  visibility: v.union(v.literal("shared"), v.literal("anonymous")),
});

export default defineSchema({
  // A problem submitted by an infrastructure operator.
  operatorRequests: defineTable({
    title: v.string(),
    description: v.string(),
    environment: v.string(),
    constraints: v.array(v.string()),
    cost: v.optional(costInfo),
    profile: v.optional(profileInfo),
    // Client-generated id that makes retries safe: create() with a token that
    // already exists returns the existing request instead of inserting again.
    clientToken: v.optional(v.string()),
    status: v.union(v.literal("submitted"), v.literal("specified")),
  })
    .index("by_status", ["status"])
    .index("by_client_token", ["clientToken"]),

  // AI-extracted structured requirements for a request. Schema only for now:
  // no functions write to this table until the AI integration exists.
  // A request may have several (re-runs); `by_request` returns them all.
  requirementSpecs: defineTable({
    requestId: v.id("operatorRequests"),
    source: v.union(v.literal("ai"), v.literal("manual")),
    model: v.optional(v.string()), // which model produced it, if source = "ai"
    summary: v.string(),
    tasks: v.array(v.string()), // what the robot must do
    environmentFactors: v.array(
      v.object({ name: v.string(), value: v.string() }), // e.g. {"surface","wet concrete"}
    ),
    requirements: v.array(
      v.object({
        kind: v.union(
          v.literal("performance"),
          v.literal("safety"),
          v.literal("environmental"),
          v.literal("budget"),
          v.literal("other"),
        ),
        description: v.string(),
        value: v.optional(v.number()),
        unit: v.optional(v.string()),
        mandatory: v.boolean(),
      }),
    ),
    confidence: v.optional(v.number()), // 0..1
    status: v.union(v.literal("draft"), v.literal("confirmed")),
  }).index("by_request", ["requestId"]),
});

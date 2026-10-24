import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const costInfo = v.object({
  currency: v.string(), // ISO 4217 code, normalised to upper case
  currentAnnualCost: v.optional(v.number()), // what the operator spends today
  budget: v.optional(v.number()), // what they'd pay for a solution
  notes: v.optional(v.string()),
});

export default defineSchema({
  // A problem submitted by an infrastructure operator.
  operatorRequests: defineTable({
    title: v.string(),
    description: v.string(),
    environment: v.string(),
    constraints: v.array(v.string()),
    cost: v.optional(costInfo),
    status: v.union(v.literal("submitted"), v.literal("specified")),
  }).index("by_status", ["status"]),

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
    followUpQuestions: v.optional(v.array(v.string())), // what the AI still needs to know
  }).index("by_request", ["requestId"]),

  // Answers the operator gave to the AI's follow-up questions.
  clarifications: defineTable({
    requestId: v.id("operatorRequests"),
    question: v.string(),
    answer: v.string(),
  }).index("by_request", ["requestId"]),

  // Robots that exist today (seed data first, Apify data later).
  robots: defineTable({
    name: v.string(),
    vendor: v.string(),
    task: v.string(), // e.g. "inspection", "mowing", "spraying"
    price: v.number(), // USD, one unit
    yearlyOpex: v.number(), // USD per year to run it
    automationShare: v.number(), // 0..1, share of the task's labor it replaces
    environments: v.array(v.string()), // e.g. ["outdoor", "confined", "wet"]
    url: v.string(),
    sample: v.boolean(), // true = made-up demo data
  }),

  // The AI's "best for you" picks for a request.
  recommendations: defineTable({
    requestId: v.id("operatorRequests"),
    picks: v.array(
      v.object({
        robotId: v.id("robots"),
        reason: v.string(),
        paybackMonths: v.union(v.number(), v.null()),
        yearlyNetSavings: v.number(),
      }),
    ),
  }).index("by_request", ["requestId"]),

  // A bounty written from "what's missing" in the existing robots.
  bounties: defineTable({
    requestId: v.id("operatorRequests"),
    title: v.string(),
    summary: v.string(),
    mustHaves: v.array(v.string()),
    niceToHaves: v.array(v.string()),
    acceptanceTest: v.string(),
    goal: v.number(), // USD, from suggestBounty(), not from the AI
    pledged: v.number(),
  }).index("by_request", ["requestId"]),

  // One row per Claude call: your cost tracker and test history.
  agentRuns: defineTable({
    route: v.string(),
    ms: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    ok: v.boolean(),
    note: v.optional(v.string()),
  }),
});
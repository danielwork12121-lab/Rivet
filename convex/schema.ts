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

// One answered follow-up question. Three kinds of data, kept apart on purpose:
// - key: stable identifier for the question (frontend vocabulary, e.g. "slope")
// - question / answerLabel: exactly what the user saw and picked (the raw answer)
// - assumption: the frontend's illustrative number for that pick. It is NOT a
//   measurement or an engineering threshold; unit is omitted when it has none.
export const followUpAnswer = v.object({
  key: v.string(),
  question: v.string(),
  answerLabel: v.string(),
  assumption: v.optional(v.object({ value: v.number(), unit: v.optional(v.string()) })),
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
    // Only questions the user actually answered; never the page's defaults.
    followUps: v.optional(v.array(followUpAnswer)),
    followUpsComplete: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()), // ms since epoch, set on every edit after creation
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
    followUpQuestions: v.optional(v.array(v.string())), // what the AI still needs to know
    jobId: v.optional(v.id("aiJobs")), // the run that produced this spec
    // The request's version (updatedAt, else _creationTime) the AI read. If the request
    // has changed since, the spec is stale.
    requestVersion: v.optional(v.number()),
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
    // Set for the page's sample products (Robot Bounty Client Flow.html PRODUCTS):
    sampleKey: v.optional(v.string()), // the page's product id, e.g. "p1"
    taskKey: v.optional(v.string()), // the page's task id, e.g. "mow"
    slopeLimitDeg: v.optional(v.number()), // illustrative
    regions: v.optional(v.array(v.string())),
    trl: v.optional(v.number()), // technology readiness level, illustrative
    provenance: v.optional(v.string()), // where these numbers come from
  }).index("by_sample_key", ["sampleKey"]),

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

  // Every bounty, whoever wrote it. One row per (request, task) once posted.
  // - status "draft":  private to the request's owner, e.g. an AI-written brief
  //                    (agent:requestBounty). Never shown on the public board.
  // - status "posted": confirmed by the operator (bounties:post). Developers see
  //                    a public projection without company or request details.
  // Money fields are illustrative demo figures in USD, not commitments.
  bounties: defineTable({
    requestId: v.id("operatorRequests"),
    status: v.union(v.literal("draft"), v.literal("posted")),
    source: v.union(v.literal("ai"), v.literal("client")),
    title: v.string(),
    // AI-written brief (source "ai")
    summary: v.optional(v.string()),
    mustHaves: v.optional(v.array(v.string())),
    niceToHaves: v.optional(v.array(v.string())),
    acceptanceTest: v.optional(v.string()),
    // The operator's own picks and words (source "client"), stored raw: escape when rendering
    taskKey: v.optional(v.string()), // the page's task id, e.g. "mow"
    gaps: v.optional(v.array(v.string())), // chip labels exactly as shown
    note: v.optional(v.string()),
    specLines: v.optional(v.array(v.string())), // the spec exactly as the operator saw it
    industry: v.optional(v.string()),
    region: v.optional(v.string()), // copied from the request profile when posted
    goal: v.number(), // USD, illustrative target
    pledged: v.number(), // USD, illustrative
    pledgePercent: v.optional(v.number()), // % of modelled first-year savings
    updatedAt: v.optional(v.number()),
  })
    .index("by_request", ["requestId"])
    .index("by_request_task", ["requestId", "taskKey"])
    .index("by_status", ["status"]),

  // One row per AI run that the operator asked for, so the page can show progress.
  // queued -> running -> succeeded | failed. Only one queued/running run per request
  // and kind at a time (repeated clicks reuse it). errorKind "unavailable" means no
  // usable credentials; "model_error" covers everything else. `error` is safe to show.
  aiJobs: defineTable({
    requestId: v.id("operatorRequests"),
    kind: v.literal("spec"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed")),
    specId: v.optional(v.id("requirementSpecs")),
    errorKind: v.optional(v.union(v.literal("unavailable"), v.literal("model_error"))),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  }).index("by_request_kind", ["requestId", "kind"]),

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
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

export const role = v.union(v.literal("client"), v.literal("developer"));
export const developerStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("revoked"));

// A robot spec found on a vendor page, in the canonical unit from lib/specs.ts,
// with the sentence it came from so the page can show its source.
export const robotSpec = v.object({
  name: v.string(), // a SPEC_NAMES entry, e.g. "max_slope_deg"
  value: v.number(),
  quote: v.string(),
  sourceUrl: v.string(),
});

// What the fast model read from the operator's message (see ai.matchRobots).
export const intentInfo = v.object({
  task: v.string(),
  searchPhrase: v.string(),
  annualTaskCost: v.union(v.number(), v.null()),
  budget: v.union(v.number(), v.null()),
  requirements: v.array(
    v.object({
      name: v.string(),
      op: v.union(v.literal("atLeast"), v.literal("atMost")),
      value: v.number(),
      mandatory: v.boolean(),
    }),
  ),
});

// One ranked robot, decided by lib/decide.ts. `reason` is added by Claude afterwards.
export const matchPick = v.object({
  robotId: v.id("robots"),
  score: v.number(),
  fit: v.array(
    v.object({
      requirement: v.string(),
      status: v.union(v.literal("meets"), v.literal("misses"), v.literal("unknown")),
      mandatory: v.boolean(),
    }),
  ),
  paybackMonths: v.union(v.number(), v.null()),
  yearlyNetSavings: v.union(v.number(), v.null()),
  breakEvenAnnualCost: v.union(v.number(), v.null()),
  // S = F(0.4C + 0.3R + 0.3E), lib/score.ts. Optional: older rows were scored the old way.
  scoreParts: v.optional(v.object({ fit: v.number(), cost: v.number(), requirements: v.number(), evidence: v.number() })),
  // Over the robot's life (lib/roi.ts lifetimeValue): NPV, TCO, ROI.
  lifetime: v.optional(v.union(v.null(), v.object({
    years: v.number(), ratePct: v.number(), upfront: v.number(), totalCost: v.number(),
    totalSavings: v.number(), npv: v.number(), roiPct: v.union(v.number(), v.null()),
  }))),
  // The hard engineering gate (lib/decide.ts compatibilityOf). Optional: older rows predate it. In
  // practice a stored pick is never "incompatible" -- lib/decide.ts filters those out before a
  // match is ever ranked -- but the literal is kept here so the type matches Compatibility exactly.
  compatibility: v.optional(v.union(
    v.literal("compatible"), v.literal("conditionally_compatible"), v.literal("insufficient_info"),
    v.literal("incompatible"),
  )),
  // Whether the automation share behind paybackMonths/yearlyNetSavings/lifetime was read off a
  // vendor page or guessed. Optional: older rows predate this distinction.
  roiConfidence: v.optional(v.union(v.literal("vendor_sourced"), v.literal("estimated"))),
  assumptions: v.array(v.string()),
  reason: v.optional(v.string()),
});

// What the page should do next, from lib/decide.ts nextAction.
// What the video analysis (api/analyze-video.js, Gemini) saw in the operator's work video. Text
// only (no frames or boxes), kept on the request so the job breakdown can use it. These are a
// model's observations, never the operator's own numbers (see ai.ts operatorText).
export const videoNotes = v.object({
  taskSummary: v.string(),
  repetitiveActions: v.array(v.string()),
  environment: v.array(v.string()),
  obstacles: v.array(v.string()),
  observedObjects: v.array(v.string()),
  requirements: v.array(v.string()),
  robotCapabilitiesNeeded: v.array(v.string()),
  analyzedAt: v.number(),
});

export const workflowStep = v.object({
  // Order of the job (1, 2, 3...). Steps with the same stage are alternatives: the crew does one.
  stage: v.optional(v.number()),
  seenInVideo: v.optional(v.boolean()), // the step shows up in the operator's work video
  name: v.string(),
  sharePct: v.number(), // share of the job's week, 0..100 (the AI's guess until the Client moves it)
  aiVerdict: v.union(v.literal("automatable"), v.literal("possible"), v.literal("person")),
  why: v.string(),
  task: v.string(), // normalised, like a match intent's task
  searchPhrase: v.string(),
  matchId: v.optional(v.id("matches")),
});

export const matchNext = v.union(
  v.object({ kind: v.literal("ask"), field: v.literal("annualTaskCost") }),
  v.object({ kind: v.literal("show_matches") }),
  v.object({ kind: v.literal("suggest_bounty"), gaps: v.array(v.string()) }),
);

// What a Client wants matched, saved on their request (see matching.ts). `basis` says where a
// requirement's number comes from: "estimate" (the Client's own rough figure) or "measured" (a figure
// the Client says they measured). Both are the Client's words; Rivet verifies neither. Robot specs read
// from vendor pages are the only verified figures (see robots.specs).
export const matchingRequirement = v.object({
  name: v.string(), // a SPEC_NAMES entry, checked on write
  op: v.union(v.literal("atLeast"), v.literal("atMost")),
  value: v.number(),
  mandatory: v.boolean(),
  basis: v.union(v.literal("estimate"), v.literal("measured")),
});
export const matchingInput = v.object({
  task: v.string(), // normalised, e.g. "mowing"
  // Absent: derive from the follow-up answers. Present (even empty): exactly these.
  requirements: v.optional(v.array(matchingRequirement)),
  updatedAt: v.number(),
});

export default defineSchema({
  // One row per signed-in person. Clerk proves who they are; this row says what
  // they may do (see lib/auth.ts). Created on first sign-in by users:ensureAccount.
  // - role: chosen once at onboarding (users:chooseRole); only an admin changes it.
  // - developerStatus: developers start "pending" and can do nothing developer-only
  //   until an admin approves them or they redeem an invite (users.ts).
  users: defineTable({
    tokenIdentifier: v.string(), // "<issuer>|<Clerk user id>" from the verified token, never from the browser
    clerkUserId: v.string(), // the token's subject
    email: v.optional(v.string()), // only if the token carries it; informational, never used for access
    name: v.optional(v.string()),
    organization: v.optional(v.string()),
    role: v.optional(role),
    developerStatus: v.optional(developerStatus),
    updatedAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_developer_status", ["developerStatus"]),

  // Single-use codes an admin hands to a developer (users:createDeveloperInvite).
  // Only a hash is stored: the code itself is shown once, to the admin.
  developerInvites: defineTable({
    codeHash: v.string(), // SHA-256 hex of the code
    note: v.optional(v.string()), // who it was for, for the admin's records
    expiresAt: v.number(), // ms since epoch
    usedBy: v.optional(v.id("users")),
    usedAt: v.optional(v.number()),
  }).index("by_code_hash", ["codeHash"]),

  // A problem submitted by an infrastructure operator.
  operatorRequests: defineTable({
    // The Client account that owns this request. Every public function checks it
    // (lib/drafts.ts). Rows from before accounts have none until claimed
    // (requests:claimLegacyDraft) and are unreachable from browsers until then.
    ownerId: v.optional(v.id("users")),
    title: v.string(),
    description: v.string(),
    environment: v.string(),
    constraints: v.array(v.string()),
    cost: v.optional(costInfo),
    profile: v.optional(profileInfo),
    matchingInput: v.optional(matchingInput), // saved by matching:saveRequirements / findRobots
    // Client-generated id that makes retries safe: create() with a token that
    // already exists returns the existing request instead of inserting again.
    // Before accounts it was also the draft's password; now it grants nothing.
    clientToken: v.optional(v.string()),
    // Only questions the user actually answered; never the page's defaults.
    followUps: v.optional(v.array(followUpAnswer)),
    followUpsComplete: v.optional(v.boolean()),
    video: v.optional(videoNotes), // requests:setVideoNotes
    updatedAt: v.optional(v.number()), // ms since epoch, set on every edit after creation
    status: v.union(v.literal("submitted"), v.literal("specified")),
  })
    .index("by_status", ["status"])
    .index("by_client_token", ["clientToken"])
    .index("by_owner", ["ownerId"]),

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
    // Set for robots found on the web (scrape.ts + ai.extractPages):
    priceStatus: v.optional(v.union(v.literal("listed"), v.literal("quote_only"))), // quote_only: price is 0, unknown
    specs: v.optional(v.array(robotSpec)),
    assumptions: v.optional(v.array(v.string())), // numbers we filled in because the page didn't say
    // True when automationShare is a default guess (no vendor page stated a labor-saved %), not a
    // verified figure. Read by lib/decide.ts so a guessed number can never earn a perfect score.
    automationShareEstimated: v.optional(v.boolean()),
    fetchedAt: v.optional(v.number()),
    imageUrl: v.optional(v.string()), // product photo from the vendor's page (og:image or similar)
  })
    .index("by_sample_key", ["sampleKey"])
    .index("by_task", ["task"])
    .index("by_url", ["url"]),

  // A web search for robots that do one task: Google search -> crawl -> extract.
  // One row per task; matches waiting for it are re-run when it finishes.
  discoveries: defineTable({
    task: v.string(), // normalised, e.g. "gutter cleaning"
    searchPhrase: v.string(),
    status: v.union(
      v.literal("searching"), v.literal("crawling"), v.literal("extracting"),
      v.literal("done"), v.literal("failed"),
    ),
    urls: v.array(v.string()),
    robotsFound: v.number(),
    waitingMatches: v.array(v.id("matches")),
    error: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_task", ["task"])
    .index("by_status", ["status"]),

  // Raw crawled pages, kept so extraction can be re-run without paying to scrape again.
  pages: defineTable({
    discoveryId: v.id("discoveries"),
    url: v.string(),
    title: v.string(),
    markdown: v.string(),
    imageUrl: v.optional(v.string()), // the page's main photo (lib/images.ts pageImage)
    extracted: v.boolean(),
    fetchedAt: v.number(),
  })
    .index("by_discovery", ["discoveryId"])
    .index("by_url", ["url"]),

  // "Find robots for me": fast read -> catalog or web search -> decide -> reasons.
  matches: defineTable({
    requestId: v.id("operatorRequests"),
    status: v.union(
      v.literal("reading"), v.literal("searching"), v.literal("ranked"),
      v.literal("done"), v.literal("failed"),
    ),
    intent: v.optional(intentInfo),
    picks: v.array(matchPick),
    next: v.optional(matchNext),
    error: v.optional(v.string()),
    msToRanked: v.optional(v.number()), // how long until picks showed (for the demo)
    // Which flow made this row: "rules" = matching.ts (saved requirements, plain code, no AI);
    // absent or "agent" = agent:findRobots (AI read + web search + reasons). Each flow only reads
    // and replaces its own rows.
    engine: v.optional(v.union(v.literal("rules"), v.literal("agent"))),
    // Set when this match searches one step of a workflow breakdown (workflows table).
    workflowId: v.optional(v.id("workflows")),
    step: v.optional(v.number()),
    // Why this match has no fresh web results: search off, a daily limit, or a search that found none.
    searchNote: v.optional(v.string()),
  })
    .index("by_request", ["requestId"])
    .index("by_status", ["status"]),

  // A job split into steps (agent:planWorkflow): what share of the week each step takes, and
  // whether a robot could do it. The biggest steps a robot might do each get a match.
  workflows: defineTable({
    requestId: v.id("operatorRequests"),
    status: v.union(v.literal("splitting"), v.literal("ready"), v.literal("failed")),
    steps: v.array(workflowStep),
    laborCost: v.union(v.number(), v.null()), // the whole job's yearly labor, USD
    budget: v.union(v.number(), v.null()), // per robot, if the Client wrote one
    requirements: intentInfo.fields.requirements, // apply to every step's search
    error: v.optional(v.string()),
  })
    .index("by_request", ["requestId"])
    .index("by_status", ["status"]),

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
    ownerId: v.optional(v.id("users")), // copied from the request when posted; never public
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

  // One row per paid AI call that was allowed to start (see lib/aiBudget.ts).
  // Used only to enforce the daily limits.
  aiUsage: defineTable({
    kind: v.union(
      v.literal("spec"), v.literal("recommend"), v.literal("bounty"), v.literal("chat"), v.literal("video"),
      v.literal("match"), // an AI robot-matching run (agent:findRobots / setTaskCost)
      v.literal("discovery"), // an Apify web search for robots (discovery.start)
    ),
    requestId: v.optional(v.id("operatorRequests")),
    clientKey: v.optional(v.string()), // keyed hash of a website visitor's IP, never the IP itself
    userId: v.optional(v.id("users")), // the signed-in account that asked
  }),

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
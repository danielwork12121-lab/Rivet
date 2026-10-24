"use node";
// Every Claude call lives in this file. "use node" lets it use the Anthropic
// SDK; such files may only export actions, so the database functions they
// call live in agent.ts and robots.ts.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { computeRoi, suggestBounty } from "./lib/roi";
import { nextAction, rankRobots, type Requirement } from "./lib/decide";
import { cleanIntent, robotFromPage } from "./lib/extract";
import { isSpecName, SPEC_NAMES } from "./lib/specs";
import type { Id } from "./_generated/dataModel";
import { PERSONAS } from "./lib/personas";

// Created per call so a key set later (npx convex env set) is picked up without a
// redeploy. Reads ANTHROPIC_API_KEY from Convex env vars.
const client = () => new Anthropic();
const MODEL = "claude-opus-5-5"; // deep layer: careful writing and judgment
const FAST_MODEL = "claude-haiku-5-5"; // fast layer: reading messages and pages

// Quick check that the key works: npx convex run ai:hello
// Internal so browsers can't spend the API key; `npx convex run` can still call it.
export const hello = internalAction({
  args: {},
  handler: async () => {
    const res = await client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Say hi to the Rivet team in five words." }],
    });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  },
});

// Record a failed run (e.g. missing ANTHROPIC_API_KEY) like extractSpec does,
// then rethrow so the scheduled function is marked failed too.
async function logFailure(ctx: ActionCtx, route: string, err: unknown) {
  await ctx.runMutation(internal.agent.logRun, {
    route, ms: 0, ok: false, inputTokens: 0, outputTokens: 0, note: String(err).slice(0, 500),
  });
}

// ---------- 1. Requirement spec + follow-up questions ----------

const SPEC_PROMPT = `You turn a problem described by an operator (an infrastructure,
facilities, lawn care or pest control business) into a requirement spec for a robot.
Rules:
- Use only facts the operator gave. Never invent numbers.
- Put anything important you don't know into followUpQuestions: at most 3 short,
  plain-language questions an owner could answer in one line.
- If the yearly cost of doing this task today is unknown, one question must ask for it.
- confidence is 0 to 1: how complete the information is.`;

const SpecSchema = z.object({
  summary: z.string(),
  tasks: z.array(z.string()),
  environmentFactors: z.array(z.object({ name: z.string(), value: z.string() })),
  requirements: z.array(
    z.object({
      kind: z.enum(["performance", "safety", "environmental", "budget", "other"]),
      description: z.string(),
      value: z.number().nullable(),
      unit: z.string().nullable(),
      mandatory: z.boolean(),
    }),
  ),
  confidence: z.number(),
  followUpQuestions: z.array(z.string()),
});
type Spec = z.infer<typeof SpecSchema>;

// Shared by the real action and the evals.
async function callSpecModel(requestJson: string) {
  const started = Date.now();
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(SpecSchema) },
    system: [{ type: "text", text: SPEC_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: requestJson }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    throw new Error(`No spec returned (stop_reason: ${res.stop_reason})`);
  }
  return { spec: res.parsed_output, ms: Date.now() - started, usage: res.usage };
}

// Missing or rejected credentials are "unavailable"; anything else is a model error.
// The message stored on the job is safe to show; the raw error goes to agentRuns.
function classify(err: unknown) {
  const text = String(err);
  return /authentication|api[_ ]?key|apiKey|401|403/i.test(text)
    ? { errorKind: "unavailable" as const, error: "The AI service is unavailable: credentials are missing or were rejected." }
    : { errorKind: "model_error" as const, error: "The AI could not produce a draft this time. You can try again." };
}

export const extractSpec = internalAction({
  args: { requestId: v.id("operatorRequests"), jobId: v.optional(v.id("aiJobs")) },
  handler: async (ctx, { requestId, jobId }) => {
    // Only one action may run a queued job: if it's already been picked up, stop.
    if (jobId && !(await ctx.runMutation(internal.agent.markJobRunning, { jobId }))) return;
    try {
      const context = await ctx.runQuery(internal.agent.requestContext, { requestId });
      // The version of the request this spec is based on; later edits make it stale.
      const requestVersion = context.request.updatedAt ?? context.request._creationTime;
      const { spec, ms, usage } = await callSpecModel(JSON.stringify(context));
      const specId = await ctx.runMutation(internal.agent.saveSpec, {
        requestId,
        model: MODEL,
        summary: spec.summary,
        tasks: spec.tasks,
        environmentFactors: spec.environmentFactors,
        // The database uses "missing" instead of null for optional numbers.
        requirements: spec.requirements.map((r) => ({
          kind: r.kind,
          description: r.description,
          mandatory: r.mandatory,
          ...(r.value !== null ? { value: r.value } : {}),
          ...(r.unit !== null ? { unit: r.unit } : {}),
        })),
        confidence: Math.min(Math.max(spec.confidence, 0), 1),
        followUpQuestions: spec.followUpQuestions.slice(0, 3),
        ...(jobId ? { jobId } : {}),
        requestVersion,
      });
      await ctx.runMutation(internal.agent.logRun, {
        route: "spec", ms, ok: true, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      });
      if (jobId) await ctx.runMutation(internal.agent.finishJob, { jobId, status: "succeeded", specId });
    } catch (err) {
      await ctx.runMutation(internal.agent.logRun, {
        route: "spec", ms: 0, ok: false, inputTokens: 0, outputTokens: 0, note: String(err),
      });
      if (jobId) await ctx.runMutation(internal.agent.finishJob, { jobId, status: "failed", ...classify(err) });
      throw err;
    }
  },
});

// ---------- 2. "Best for you" robot picks (tool loop) ----------

const RECOMMEND_PROMPT = `You recommend existing robots to an operator.
1. Call search_catalog to find candidates (try more than one task word if needed).
2. Call compute_roi for every robot you might recommend.
3. Call submit_picks once with up to 3 robots, best first.
Each reason is one sentence about this operator's situation. If you mention money or
months, copy the exact numbers from compute_roi. Never calculate numbers yourself.
If nothing fits, call submit_picks with an empty list.`;

// Finds "$12,000" and "9 months" in a sentence.
function numbersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\$\s?([\d,]+)|(\d+)\s*months?/g)) {
    found.push((m[1] ?? m[2]).replace(/,/g, ""));
  }
  return found;
}

export const recommendRobots = internalAction({
  args: { requestId: v.id("operatorRequests"), maxPrice: v.optional(v.number()) },
  handler: async (ctx, { requestId, maxPrice }) => {
   try {
    const context = await ctx.runQuery(internal.agent.requestContext, { requestId });
    const spec = await ctx.runQuery(internal.agent.latestSpecInternal, { requestId });
    const annualCost = context.request.cost?.currentAnnualCost;
    const started = Date.now();

    // Filled in by the tools below, then checked before saving.
    const roiByRobot = new Map<string, ReturnType<typeof computeRoi>>();
    const allowedNumbers = new Set<string>();
    let submitted: { robotId: string; reason: string }[] | null = null;

    const searchCatalog = betaZodTool({
      name: "search_catalog",
      description: "List robots for a task (e.g. inspection, mowing, spraying). Returns id, name, price, environments.",
      inputSchema: z.object({ task: z.string() }),
      run: async ({ task }) =>
        JSON.stringify(await ctx.runQuery(internal.robots.searchInternal, { task, maxPrice })),
    });

    const computeRoiTool = betaZodTool({
      name: "compute_roi",
      description: "Exact yearly savings and payback months for this operator using one robot.",
      inputSchema: z.object({ robotId: z.string() }),
      run: async ({ robotId }) => {
        const robot = await ctx.runQuery(internal.robots.getByString, { id: robotId });
        if (!robot) return "Unknown robot id.";
        if (annualCost === undefined) return "Unknown: the operator has not said what this task costs per year.";
        const roi = computeRoi({
          currentAnnualCost: annualCost,
          robotPrice: robot.price,
          yearlyOpex: robot.yearlyOpex,
          automationShare: robot.automationShare,
        });
        roiByRobot.set(robotId, roi);
        for (const n of [robot.price, roi.yearlyLaborSaved, roi.yearlyNetSavings, roi.paybackMonths]) {
          if (n !== null) allowedNumbers.add(String(n));
        }
        return JSON.stringify({ robotPrice: robot.price, ...roi });
      },
    });

    const submitPicks = betaZodTool({
      name: "submit_picks",
      description: "Submit your final picks, best first.",
      inputSchema: z.object({
        picks: z.array(z.object({ robotId: z.string(), reason: z.string() })).max(3),
      }),
      run: async ({ picks }) => {
        submitted = picks;
        return "Saved.";
      },
    });

    const final = await client().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system: RECOMMEND_PROMPT,
      tools: [searchCatalog, computeRoiTool, submitPicks],
      messages: [{ role: "user", content: JSON.stringify({ ...context, spec, maxPrice }) }],
    });

    // Keep only picks that are real robots with grounded numbers.
    const picks: { robotId: string; reason: string }[] = submitted ?? [];
    const valid = [];
    const dropped: string[] = [];
    for (const p of picks) {
      const robot = await ctx.runQuery(internal.robots.getByString, { id: p.robotId });
      const ungrounded = numbersIn(p.reason).filter((n) => !allowedNumbers.has(n));
      if (!robot || ungrounded.length > 0) {
        dropped.push(`${p.robotId}: ${robot ? "made-up numbers " + ungrounded.join(",") : "unknown id"}`);
        continue;
      }
      const roi = roiByRobot.get(p.robotId);
      valid.push({
        robotId: robot._id,
        reason: p.reason,
        paybackMonths: roi?.paybackMonths ?? null,
        yearlyNetSavings: roi?.yearlyNetSavings ?? 0,
      });
    }

    await ctx.runMutation(internal.agent.savePicks, { requestId, picks: valid });
    await ctx.runMutation(internal.agent.logRun, {
      route: "recommend",
      ms: Date.now() - started,
      ok: dropped.length === 0,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      ...(dropped.length ? { note: "dropped " + dropped.join("; ") } : {}),
    });
   } catch (err) {
    await logFailure(ctx, "recommend", err);
    throw err;
   }
  },
});

// ---------- 3. Bounty spec from "what's missing" ----------

const BOUNTY_PROMPT = `Write a bounty brief for robotics teams. The operator looked at
existing robots and said what is missing. Every point in "gap" must become a must-have
or a constraint. The acceptance test must be measurable (a number or a clear pass/fail).
Do not include prices: the goal amount is set separately.`;

const BountySchema = z.object({
  title: z.string(),
  summary: z.string(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  acceptanceTest: z.string(),
});

export const writeBounty = internalAction({
  args: { requestId: v.id("operatorRequests"), robotId: v.optional(v.id("robots")), gap: v.string() },
  handler: async (ctx, { requestId, robotId, gap }) => {
   try {
    const context = await ctx.runQuery(internal.agent.requestContext, { requestId });
    const spec = await ctx.runQuery(internal.agent.latestSpecInternal, { requestId });
    const robot = robotId ? await ctx.runQuery(internal.robots.getByString, { id: robotId }) : null;
    const started = Date.now();

    const res = await client().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(BountySchema) },
      system: BOUNTY_PROMPT,
      messages: [{ role: "user", content: JSON.stringify({ ...context, spec, closestRobot: robot, gap }) }],
    });
    if (!res.parsed_output) throw new Error(`No bounty returned (stop_reason: ${res.stop_reason})`);

    // The goal comes from our math, not from Claude.
    const annualCost = context.request.cost?.currentAnnualCost ?? 0;
    const goal = suggestBounty(annualCost * 0.6); // assume a new robot saves ~60%

    await ctx.runMutation(internal.agent.saveBounty, { requestId, ...res.parsed_output, goal });
    await ctx.runMutation(internal.agent.logRun, {
      route: "bounty", ms: Date.now() - started, ok: true,
      inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
    });
   } catch (err) {
    await logFailure(ctx, "bounty", err);
    throw err;
   }
  },
});

// ---------- 4. Robot specs from crawled vendor pages ----------
// scrape.ts saves pages; this reads each one with the fast model. lib/extract.ts
// then keeps only numbers whose quote is really on the page.

const EXTRACT_PROMPT = `You read one web page and extract the robot product it describes, for a
marketplace that helps small trade businesses (lawn care, cleaning, pest control,
facilities, construction) find robots.
- isRobotProduct: true only if the page is about one specific robot or autonomous machine
  that can be bought or leased. Blog posts, news, lists of many products and company
  home pages without one product: false.
- For every number, copy the exact sentence or table row from the page into quote, and
  give value and unit exactly as written there. If the page doesn't state it, use null
  for value, unit and quote. Never estimate or convert.
- price: purchase price in USD. If the page says to contact sales or request a quote,
  priceOnRequest is true and price is null.
- yearlyRunningCost: a stated yearly subscription, service plan or maintenance cost in USD.
- laborSavedPercent: a stated share of labor or time saved, e.g. "cuts labor by 60%" is 60.
- specs: only these names: ${SPEC_NAMES.join(", ")}.`;

const Evidence = z.object({ value: z.number().nullable(), unit: z.string().nullable(), quote: z.string().nullable() });
const RobotPageSchema = z.object({
  isRobotProduct: z.boolean(),
  name: z.string(),
  vendor: z.string(),
  priceOnRequest: z.boolean(),
  price: Evidence,
  yearlyRunningCost: Evidence,
  laborSavedPercent: Evidence,
  specs: z.array(z.object({ name: z.enum(SPEC_NAMES), value: z.number(), unit: z.string(), quote: z.string() })),
  environments: z.array(z.string()),
});

export const extractPages = internalAction({
  args: { discoveryId: v.id("discoveries") },
  handler: async (ctx, { discoveryId }) => {
    const discovery = await ctx.runQuery(internal.discovery.get, { discoveryId });
    if (!discovery) return;
    const pages = await ctx.runQuery(internal.discovery.pagesToExtract, { discoveryId });
    let robotsFound = 0;
    // One page at a time keeps this simple; a few pages take about a minute.
    for (const page of pages) {
      const started = Date.now();
      try {
        const res = await client().messages.parse({
          model: FAST_MODEL,
          max_tokens: 8000,
          output_config: { effort: "low", format: zodOutputFormat(RobotPageSchema) },
          system: [{ type: "text", text: EXTRACT_PROMPT, cache_control: { type: "ephemeral" } }],
          // Product facts are near the top; the cap keeps one huge page from costing much.
          messages: [{ role: "user", content: `URL: ${page.url}\n\n${page.markdown.slice(0, 40_000)}` }],
        });
        const robot = res.parsed_output && robotFromPage(res.parsed_output, page, discovery.task);
        if (robot) {
          await ctx.runMutation(internal.robots.upsertScraped, robot);
          robotsFound++;
        }
        await ctx.runMutation(internal.agent.logRun, {
          route: "extract", ms: Date.now() - started, ok: true,
          inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
          note: robot ? `robot: ${robot.name}` : `not a product: ${page.url}`.slice(0, 300),
        });
      } catch (err) {
        await logFailure(ctx, "extract", err);
      }
      await ctx.runMutation(internal.discovery.markExtracted, { pageId: page._id });
    }
    await ctx.runMutation(internal.discovery.finish, { discoveryId, status: "done", robotsFound });
  },
});

// ---------- 5. "Find robots for me": fast read -> decide -> explain ----------

const INTENT_PROMPT = `Read a small trade business's request and pull out what a robot search needs.
- task: 1 to 3 lowercase words naming the job a robot would do, e.g. "mowing",
  "gutter cleaning", "weed spraying", "floor scrubbing". If one of knownTasks fits, use it exactly.
- searchPhrase: 2 to 5 words a buyer would type into Google to find such robots,
  e.g. "commercial robotic mower".
- annualTaskCost: what they spend per year on this task in USD, and budget: what they
  would pay for a robot in USD. Only if the operator wrote the number; otherwise null.
  Never estimate or calculate.
- requirements: measurable needs the operator stated or picked, using only these names:
  ${SPEC_NAMES.join(", ")}. Give value and unit exactly as written; don't convert.
  op is atLeast for minimums (slope it must handle, runtime) and atMost for maximums
  (weight limit). mandatory is true unless they said it's a nice-to-have.`;

const IntentSchema = z.object({
  task: z.string(),
  searchPhrase: z.string(),
  annualTaskCost: z.number().nullable(),
  budget: z.number().nullable(),
  requirements: z.array(
    z.object({
      name: z.enum(SPEC_NAMES),
      op: z.enum(["atLeast", "atMost"]),
      value: z.number(),
      unit: z.string(),
      mandatory: z.boolean(),
    }),
  ),
});

const REASONS_PROMPT = `You explain robot matches to the owner of a small trade business.
Code has already ranked the robots, checked each requirement and done the money math.
Don't change or recompute any of it.
For each robot write one or two plain sentences on why it does or doesn't fit this
operator, naming the most important requirement it meets or misses. If you mention
money or months, copy the exact numbers given. Numbers listed under assumptions are
estimates: say so if you use them. Use the robotId given for each robot.`;

const ReasonsSchema = z.object({
  reasons: z.array(z.object({ robotId: z.string(), reason: z.string() })),
});

export const matchRobots = internalAction({
  args: { matchId: v.id("matches"), searched: v.optional(v.boolean()) },
  handler: async (ctx, { matchId, searched }) => {
    const match = await ctx.runQuery(internal.agent.getMatch, { matchId });
    if (!match) return;
    const started = Date.now();
    try {
      const context = await ctx.runQuery(internal.agent.requestContext, { requestId: match.requestId });

      // 1. Fast layer: read the message (about a second). Reused after a web search.
      let intent = match.intent;
      if (!intent) {
        const knownTasks = await ctx.runQuery(internal.robots.knownTasks, {});
        const res = await client().messages.parse({
          model: FAST_MODEL,
          max_tokens: 4000,
          output_config: { effort: "low", format: zodOutputFormat(IntentSchema) },
          system: [{ type: "text", text: INTENT_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: JSON.stringify({ knownTasks, ...context }) }],
        });
        if (!res.parsed_output) throw new Error(`No intent returned (stop_reason: ${res.stop_reason})`);
        intent = cleanIntent(res.parsed_output, JSON.stringify(context), context.request.cost?.currentAnnualCost);
        await ctx.runMutation(internal.agent.patchMatch, { matchId, intent });
        await ctx.runMutation(internal.agent.logRun, {
          route: "intent", ms: Date.now() - started, ok: true,
          inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
        });
      }

      // 2. Catalog, or a web search when we have no real robots for this task yet.
      // Only real robots: the fictional demo ones are never shown to operators.
      const robots = (await ctx.runQuery(internal.robots.forTask, { task: intent.task })).filter((r) => !r.sample);
      if (!searched && robots.length === 0 && process.env.APIFY_TOKEN) {
        const search = await ctx.runMutation(internal.discovery.start, {
          task: intent.task, searchPhrase: intent.searchPhrase, matchId,
        });
        if (search !== "done") {
          // discovery.finish runs this again with searched: true.
          await ctx.runMutation(internal.agent.patchMatch, { matchId, status: "searching" });
          return;
        }
      }

      // 3. Decision layer: plain code, milliseconds.
      const typed = { ...intent, requirements: intent.requirements.filter((r) => isSpecName(r.name)) as Requirement[] };
      const ranked = rankRobots(typed, robots.map((r) => ({ ...r, _id: r._id as string })));
      const next = nextAction(typed, ranked);
      const picks = ranked.map((p) => ({ ...p, robotId: p.robotId as Id<"robots"> }));
      await ctx.runMutation(internal.agent.patchMatch, {
        matchId, status: "ranked", picks, next, msToRanked: Date.now() - match._creationTime,
      });
      if (picks.length === 0) {
        await ctx.runMutation(internal.agent.patchMatch, { matchId, status: "done" });
        return;
      }

      // 4. Deep layer: the strong model explains the decision in one call.
      const byId = new Map(robots.map((r) => [r._id as string, r]));
      const allowed = new Set<string>();
      const forClaude = picks.map((p) => {
        const r = byId.get(p.robotId)!;
        const price = r.priceStatus === "quote_only" ? null : r.price;
        for (const n of [price, p.paybackMonths, p.yearlyNetSavings, p.breakEvenAnnualCost, intent.annualTaskCost, intent.budget]) {
          if (n !== null && n !== undefined) allowed.add(String(n));
        }
        return {
          robotId: p.robotId, name: r.name, vendor: r.vendor, price: price ?? "price on request",
          fit: p.fit, paybackMonths: p.paybackMonths, yearlyNetSavings: p.yearlyNetSavings,
          annualTaskCostToPayBackIn24Months: p.breakEvenAnnualCost, assumptions: p.assumptions,
          specs: (r.specs ?? []).map((s) => ({ name: s.name, value: s.value })),
        };
      });
      const deepStarted = Date.now();
      const res = await client().messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low", format: zodOutputFormat(ReasonsSchema) },
        system: REASONS_PROMPT,
        messages: [{ role: "user", content: JSON.stringify({ operator: context.request.description, intent, next, robots: forClaude }) }],
      });
      const dropped: string[] = [];
      const withReasons = picks.map((p) => {
        const reason = res.parsed_output?.reasons.find((x) => x.robotId === p.robotId)?.reason;
        if (!reason) return p;
        const madeUp = numbersIn(reason).filter((n) => !allowed.has(n));
        if (madeUp.length) {
          dropped.push(`${p.robotId}: ${madeUp.join(",")}`);
          return p;
        }
        return { ...p, reason };
      });
      await ctx.runMutation(internal.agent.patchMatch, { matchId, status: "done", picks: withReasons });
      await ctx.runMutation(internal.agent.logRun, {
        route: "reasons", ms: Date.now() - deepStarted, ok: dropped.length === 0,
        inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
        ...(dropped.length ? { note: "dropped made-up numbers " + dropped.join("; ") } : {}),
      });
    } catch (err) {
      await logFailure(ctx, "match", err);
      // Keep any picks already shown; only mark failed if nothing was ranked yet.
      const latest = await ctx.runQuery(internal.agent.getMatch, { matchId });
      await ctx.runMutation(internal.agent.patchMatch, {
        matchId,
        status: latest && latest.picks.length > 0 ? "done" : "failed",
        error: classify(err).error,
      });
    }
  },
});

// ---------- Evals: npx convex run ai:runEvals ----------
// Internal for the same reason as hello.

export const runEvals = internalAction({
  args: {},
  handler: async () => {
    const results = [];
    for (const p of PERSONAS) {
      const { currentAnnualCost, ...rest } = p.request;
      const request = {
        ...rest,
        ...(currentAnnualCost !== undefined ? { cost: { currency: "USD", currentAnnualCost } } : {}),
      };
      try {
        const { spec } = await callSpecModel(JSON.stringify({ request, answers: [] }));
        const problems = checkSpec(spec, p);
        results.push({ persona: p.name, pass: problems.length === 0, problems });
      } catch (err) {
        results.push({ persona: p.name, pass: false, problems: [String(err)] });
      }
    }
    const passed = results.filter((r) => r.pass).length;
    return { passed: `${passed}/${results.length}`, results };
  },
});

function checkSpec(spec: Spec, p: (typeof PERSONAS)[number]): string[] {
  const problems: string[] = [];
  const tasks = spec.tasks.join(" ").toLowerCase();
  const questions = spec.followUpQuestions.join(" ").toLowerCase();
  if (p.expect.taskIncludes && !tasks.includes(p.expect.taskIncludes)) {
    problems.push(`tasks don't mention "${p.expect.taskIncludes}"`);
  }
  if (p.expect.mustAskAbout !== undefined) {
    if (spec.followUpQuestions.length === 0) problems.push("asked no follow-up questions");
    else if (p.expect.mustAskAbout && !questions.includes(p.expect.mustAskAbout)) {
      problems.push(`no question about "${p.expect.mustAskAbout}"`);
    }
  }
  if (spec.followUpQuestions.length > 3) problems.push("more than 3 questions");
  return problems;
}
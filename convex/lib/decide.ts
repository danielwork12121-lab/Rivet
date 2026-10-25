// The decision layer: plain functions that decide everything the AI used to.
// Fast (milliseconds), testable, and they can't make anything up. Claude only
// reads the operator's message before this and explains the result after.
import { breakEvenAnnualCost, computeRoi, lifetimeValue, type Lifetime } from "./roi";
import { matchScore, scoreParts, type ScoreParts } from "./score";
import { SPEC_LABELS, type SpecName } from "./specs";

export type Requirement = {
  name: SpecName;
  op: "atLeast" | "atMost";
  value: number; // canonical unit (see specs.ts)
  mandatory: boolean;
};

export type Intent = {
  task: string; // normalised, e.g. "mowing"
  annualTaskCost: number | null; // what the operator spends on this task per year
  budget: number | null;
  requirements: Requirement[];
};

// The fields of a robot row the decision layer reads.
export type RobotFacts = {
  _id: string;
  name: string;
  price: number;
  priceStatus?: "listed" | "quote_only";
  yearlyOpex: number;
  automationShare: number;
  specs?: { name: string; value: number }[];
  slopeLimitDeg?: number; // sample robots store slope here
  assumptions?: string[];
  environments?: string[]; // e.g. ["outdoor"], ["indoor"] -- read by compatibilityOf below
  // True when automationShare (and so every dollar figure derived from it) is a guess the
  // extraction pipeline filled in because no vendor page stated a labor-saved percentage --
  // never a figure we're confident enough in to call "verified". See lib/extract.ts.
  automationShareEstimated?: boolean;
};

export type FitRow = { requirement: string; status: "meets" | "misses" | "unknown"; mandatory: boolean };

// A hard engineering check, run before scoring, independent of how well the robot otherwise
// scores. "incompatible" robots never reach the ranked list at all -- being affordable or
// having a fast theoretical payback can't buy back a robot that physically can't do the job.
// The other three values are informational (shown on the card) and don't change the score here;
// low confidence in automationShare already pulls the score down via scoreParts' evidence term.
export type Compatibility = "compatible" | "conditionally_compatible" | "insufficient_info" | "incompatible";

export type RankedRobot = {
  robotId: string;
  score: number; // 0..100, lib/score.ts
  scoreParts: ScoreParts;
  fit: FitRow[];
  compatibility: Compatibility;
  paybackMonths: number | null;
  yearlyNetSavings: number | null;
  breakEvenAnnualCost: number | null;
  lifetime: Lifetime | null; // NPV / TCO / ROI over the robot's life, when price and yearly cost are known
  roiConfidence: "vendor_sourced" | "estimated"; // "estimated": automationShare is a guess, not read off a vendor page
  assumptions: string[];
};

export type NextAction =
  | { kind: "ask"; field: "annualTaskCost" }
  | { kind: "show_matches" }
  | { kind: "suggest_bounty"; gaps: string[] };

export function normalizeTask(task: string): string {
  return task.toLowerCase().replace(/\s+/g, " ").trim();
}

function specValue(robot: RobotFacts, name: SpecName): number | undefined {
  const found = robot.specs?.find((s) => s.name === name)?.value;
  if (found !== undefined) return found;
  return name === "max_slope_deg" ? robot.slopeLimitDeg : undefined;
}

function describe(r: Requirement): string {
  return `${SPEC_LABELS[r.name]} ${r.op === "atLeast" ? "at least" : "at most"} ${r.value}`;
}

// Word fragments that mark a task as normally done outdoors or normally done indoors. Deliberately
// coarse (a task name is 1-3 words): this only needs to catch the clear cases -- a lawn-mowing or
// embankment-clearing task is never done by an indoor floor-cleaning robot, and vice versa. Anything
// it can't place either way falls through as "insufficient_info", not a silent pass.
const OUTDOOR_TASK_WORDS = [
  "mow", "lawn", "turf", "grass", "slope", "embankment", "hillside", "vegetation", "brush",
  "landscap", "yard", "garden", "spray", "weed", "outdoor", "grounds", "trim", "edging", "drainage",
  "gutter", "roof", "solar", "paving", "sidewalk", "parking",
];
const INDOOR_TASK_WORDS = ["floor", "carpet", "indoor", "warehouse", "tile", "janitorial", "vacuum"];

function matchesAny(task: string, words: string[]): boolean {
  const t = task.toLowerCase();
  return words.some((w) => t.includes(w));
}

// Above this annual cost, the task is almost certainly being done by more than one worker or
// crew, not a single person. Nothing in the operator's message says how many robots a job this
// size would need (there's no "total area" or "crew count" field to check a robot's coverage
// spec against), so per the spec's fallback -- "else don't assume one cheap robot replaces a
// crew" -- this flags the uncertainty in words instead of inventing a fleet-count number. A
// vendor-stated automationShare also isn't exonerated here: it was very unlikely to have been
// measured against a job at this scale, so it gets treated as unverified for THIS job too.
const LARGE_OPERATION_ANNUAL_COST = 150_000;

// Kept as a substring the existing frontend already recognizes (pages/index.html greys out and
// caveats a pick's savings/payback whenever an assumption includes "Assumed to replace"), so a
// fleet-scale caveat gets the same visual treatment with no frontend change required.
function fleetSizingCaveat(intent: Intent): string | null {
  if (intent.annualTaskCost === null || intent.annualTaskCost < LARGE_OPERATION_ANNUAL_COST) return null;
  return (
    `Assumed to replace this share of the task's cost with a single unit, not a fleet. This task's ` +
    `annual cost suggests more than one worker or crew, and nothing here checks this robot's real ` +
    `coverage/throughput against the full job size -- confirm how many units a job this size would ` +
    `actually need before relying on this as a one-robot replacement for a commercial-scale operation.`
  );
}

// The hard engineering gate from the spec: indoor-only robots for outdoor tasks (and the reverse)
// are "incompatible" and excluded from the ranked list outright, however well they'd otherwise
// score. A robot with no environment recorded, or a task this list can't place, is "insufficient_info"
// rather than guessed either way. Everything else is "compatible", or "conditionally_compatible" when
// its ROI-driving automationShare is a guess rather than a vendor-stated figure.
export function compatibilityOf(intent: Intent, robot: RobotFacts): Compatibility {
  const envs = (robot.environments ?? []).map((e) => e.toLowerCase());
  const saysIndoor = envs.includes("indoor");
  const saysOutdoor = envs.includes("outdoor");
  const taskIsOutdoor = matchesAny(intent.task, OUTDOOR_TASK_WORDS);
  const taskIsIndoor = matchesAny(intent.task, INDOOR_TASK_WORDS);
  if (taskIsOutdoor && saysIndoor && !saysOutdoor) return "incompatible";
  if (taskIsIndoor && saysOutdoor && !saysIndoor) return "incompatible";
  if (envs.length === 0 || (taskIsOutdoor && !saysOutdoor) || (taskIsIndoor && !saysIndoor)) {
    return "insufficient_info";
  }
  return robot.automationShareEstimated ? "conditionally_compatible" : "compatible";
}

// Each requirement marked meets, misses or unknown, from the robot's specs.
export function fitCheck(intent: Intent, robot: RobotFacts): FitRow[] {
  const rows: FitRow[] = intent.requirements.map((r) => {
    const v = specValue(robot, r.name);
    const status = v === undefined ? "unknown" : (r.op === "atLeast" ? v >= r.value : v <= r.value) ? "meets" : "misses";
    return { requirement: describe(r), status, mandatory: r.mandatory };
  });
  if (intent.budget !== null) {
    const status = robot.priceStatus === "quote_only" ? "unknown" : robot.price <= intent.budget ? "meets" : "misses";
    rows.push({ requirement: `Price at most $${intent.budget}`, status, mandatory: true });
  }
  return rows;
}

// Scores every robot for this operator (lib/score.ts) and returns the best three.
// Robots that miss a must-have all score 0; among those (and on ties) the closest one comes first
// (+10 per requirement met, -40 per mandatory miss, -10 per optional miss, -2 per unknown, up to
// +30 for a fast payback), so the bounty suggestion names the fewest gaps.
export function rankRobots(intent: Intent, robots: RobotFacts[], limit = 3): RankedRobot[] {
  return robots
    // The hard engineering gate runs first and is final: an indoor-only robot for an outdoor job
    // (or the reverse) never reaches scoring, however cheap or fast-payback it looks on paper.
    .filter((robot) => compatibilityOf(intent, robot) !== "incompatible")
    .map((robot) => {
      const compatibility = compatibilityOf(intent, robot);
      const fit = fitCheck(intent, robot);
      const priced = robot.priceStatus !== "quote_only";
      const roiInput = { robotPrice: robot.price, yearlyOpex: robot.yearlyOpex, automationShare: robot.automationShare };
      const roi = priced && intent.annualTaskCost !== null
        ? computeRoi({ currentAnnualCost: intent.annualTaskCost, ...roiInput })
        : null;
      // A job this size can't be assumed to need just one unit (see fleetSizingCaveat above):
      // treat the automationShare basis as unverified for THIS job even when a vendor stated it,
      // and say so in words rather than inventing a fleet count.
      const fleetCaveat = fleetSizingCaveat(intent);
      const automationShareSourced = !robot.automationShareEstimated && !fleetCaveat;
      let closeness = 0;
      for (const f of fit) {
        if (f.status === "meets") closeness += 10;
        else if (f.status === "misses") closeness -= f.mandatory ? 40 : 10;
        else closeness -= 2;
      }
      if (roi?.paybackMonths != null) closeness += Math.max(0, 30 - roi.paybackMonths / 2);
      const parts = scoreParts({
        fit, requirementCount: intent.requirements.length, price: robot.price,
        sourcedSpecs: intent.requirements.filter((r) => robot.specs?.some((s) => s.name === r.name)).length,
        priceListed: priced, priceSourced: robot.priceStatus === "listed",
        budget: intent.budget, paybackMonths: roi?.paybackMonths ?? null, hasRoi: roi !== null,
        // A guessed automation share counts as missing evidence: a robot can't score a perfect
        // 100/100 on the strength of a number nobody actually verified -- and nor can a job whose
        // scale was never checked against this robot's real throughput (fleetCaveat above).
        automationShareSourced,
      });
      const exact = matchScore(parts);
      return {
        exact,
        ranked: {
          robotId: robot._id,
          score: Math.round(exact),
          scoreParts: parts,
          fit,
          compatibility,
          paybackMonths: roi?.paybackMonths ?? null,
          yearlyNetSavings: roi?.yearlyNetSavings ?? null,
          breakEvenAnnualCost: priced ? breakEvenAnnualCost(roiInput) : null,
          lifetime: roi
            ? lifetimeValue({ robotPrice: robot.price, yearlyLaborSaved: roi.yearlyLaborSaved, yearlyOpex: robot.yearlyOpex })
            : null,
          roiConfidence: automationShareSourced ? ("vendor_sourced" as const) : ("estimated" as const),
          assumptions: fleetCaveat ? [...(robot.assumptions ?? []), fleetCaveat] : (robot.assumptions ?? []),
        },
        closeness,
      };
    })
    .sort((a, b) => b.exact - a.exact || b.closeness - a.closeness)
    .slice(0, limit)
    .map((r) => r.ranked);
}

// What the page should do next.
export function nextAction(intent: Intent, ranked: RankedRobot[]): NextAction {
  const best = ranked[0];
  const gaps = best ? best.fit.filter((f) => f.status === "misses" && f.mandatory).map((f) => f.requirement) : [];
  if (!best || gaps.length > 0) return { kind: "suggest_bounty", gaps: best ? gaps : ["No robot found for this task"] };
  if (intent.annualTaskCost === null) return { kind: "ask", field: "annualTaskCost" };
  return { kind: "show_matches" };
}

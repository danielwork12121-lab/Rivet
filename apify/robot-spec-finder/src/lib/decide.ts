// The decision layer: plain functions that decide everything the AI used to.
// Fast (milliseconds), testable, and they can't make anything up. Claude only
// reads the operator's message before this and explains the result after.
import { breakEvenAnnualCost, computeRoi } from "./roi.js";
import { SPEC_LABELS, type SpecName } from "./specs.js";

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
};

export type FitRow = { requirement: string; status: "meets" | "misses" | "unknown"; mandatory: boolean };

export type RankedRobot = {
  robotId: string;
  score: number;
  fit: FitRow[];
  paybackMonths: number | null;
  yearlyNetSavings: number | null;
  breakEvenAnnualCost: number | null;
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

// Scores every robot for this operator and returns the best three.
// Score: +10 per requirement met, -40 per mandatory miss, -10 per optional miss,
// -2 per unknown, plus up to +30 for a fast payback. Tune with the personas.
export function rankRobots(intent: Intent, robots: RobotFacts[], limit = 3): RankedRobot[] {
  return robots
    .map((robot) => {
      const fit = fitCheck(intent, robot);
      const priced = robot.priceStatus !== "quote_only";
      const roiInput = { robotPrice: robot.price, yearlyOpex: robot.yearlyOpex, automationShare: robot.automationShare };
      const roi = priced && intent.annualTaskCost !== null
        ? computeRoi({ currentAnnualCost: intent.annualTaskCost, ...roiInput })
        : null;
      let score = 0;
      for (const f of fit) {
        if (f.status === "meets") score += 10;
        else if (f.status === "misses") score -= f.mandatory ? 40 : 10;
        else score -= 2;
      }
      if (roi?.paybackMonths != null) score += Math.max(0, 30 - roi.paybackMonths / 2);
      return {
        robotId: robot._id,
        score: Math.round(score),
        fit,
        paybackMonths: roi?.paybackMonths ?? null,
        yearlyNetSavings: roi?.yearlyNetSavings ?? null,
        breakEvenAnnualCost: priced ? breakEvenAnnualCost(roiInput) : null,
        assumptions: robot.assumptions ?? [],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// What the page should do next.
export function nextAction(intent: Intent, ranked: RankedRobot[]): NextAction {
  const best = ranked[0];
  const gaps = best ? best.fit.filter((f) => f.status === "misses" && f.mandatory).map((f) => f.requirement) : [];
  if (!best || gaps.length > 0) return { kind: "suggest_bounty", gaps: best ? gaps : ["No robot found for this task"] };
  if (intent.annualTaskCost === null) return { kind: "ask", field: "annualTaskCost" };
  return { kind: "show_matches" };
}

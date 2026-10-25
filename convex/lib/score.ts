// The match score shown on each robot, 0 to 100:
//   S = F * (0.4 C + 0.3 R + 0.3 E)
// F  fit gate: 1 if the robot meets every must-have it can be checked on, else 0
// C  cost fit: how fast it pays back (instant = 1, five years or never = 0); without a payback,
//    price against the budget; unknown price = 0.5
// R  requirements: share of the operator's requirements the robot is known to meet
// E  evidence: share of what we judge it on (each requirement's spec, and the price) that was read
//    from the vendor's page. Every saved spec carries the sentence it was read from (robots.specs);
//    a fictional sample robot's figures count as no evidence.
import type { FitRow } from "./decide";

export const WEIGHTS = { cost: 0.4, requirements: 0.3, evidence: 0.3 } as const;
const PAYBACK_ZERO_MONTHS = 60;

export type ScoreParts = { fit: 0 | 1; cost: number; requirements: number; evidence: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function scoreParts(input: {
  fit: FitRow[]; // fitCheck rows: one per requirement, then the budget row if there's a budget
  requirementCount: number;
  sourcedSpecs: number; // requirements whose value came from a quoted vendor spec
  priceListed: boolean; // a price is known
  priceSourced: boolean; // ...and was read from the vendor's page
  price: number;
  budget: number | null;
  paybackMonths: number | null;
  hasRoi: boolean; // a payback could be worked out (price and yearly cost known)
}): ScoreParts {
  const reqRows = input.fit.slice(0, input.requirementCount);
  const fit = input.fit.some((f) => f.mandatory && f.status === "misses") ? 0 : 1;

  let cost = 0.5;
  if (!input.priceListed) cost = 0.5;
  else if (input.hasRoi) cost = input.paybackMonths === null ? 0 : clamp01(1 - input.paybackMonths / PAYBACK_ZERO_MONTHS);
  else if (input.budget !== null && input.budget > 0) cost = input.price <= input.budget ? 1 - 0.5 * (input.price / input.budget) : 0;

  const requirements = reqRows.length ? reqRows.filter((f) => f.status === "meets").length / reqRows.length : 1;
  const evidence = (Math.min(input.sourcedSpecs, reqRows.length) + (input.priceSourced ? 1 : 0)) / (reqRows.length + 1);

  return { fit, cost: round2(cost), requirements: round2(requirements), evidence: round2(evidence) };
}

// Unrounded, for sorting; round it for display.
export function matchScore(p: ScoreParts): number {
  return 100 * p.fit * (WEIGHTS.cost * p.cost + WEIGHTS.requirements * p.requirements + WEIGHTS.evidence * p.evidence);
}

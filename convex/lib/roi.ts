// All money math lives here, as plain functions. Claude never calculates
// numbers itself: it calls these through tools and quotes the results.

export type RoiInput = {
  currentAnnualCost: number; // what the operator spends on this task per year
  robotPrice: number;
  yearlyOpex: number;
  automationShare: number; // 0..1
};

export type RoiResult = {
  yearlyLaborSaved: number;
  yearlyNetSavings: number;
  paybackMonths: number | null; // null = never pays back
  paybackRange: [number | null, number | null]; // if savings are 20% better / worse
};

function payback(price: number, yearlySavings: number): number | null {
  if (yearlySavings <= 0) return null;
  return Math.round((price / yearlySavings) * 12);
}


// payback months = robot price + (labor saved - running cost) * 12.
export function computeRoi(input: RoiInput): RoiResult {
  const yearlyLaborSaved = Math.round(input.currentAnnualCost * input.automationShare);
  const yearlyNetSavings = yearlyLaborSaved - input.yearlyOpex;
  return {
    yearlyLaborSaved,
    yearlyNetSavings,
    paybackMonths: payback(input.robotPrice, yearlyNetSavings),
    paybackRange: [
      payback(input.robotPrice, yearlyNetSavings * 1.2),
      payback(input.robotPrice, yearlyNetSavings * 0.8),
    ],
  };
}

// Suggested bounty goal: 30% of a year's net savings (middle of 20-40%),
// rounded to the nearest $100 so it reads like a real price.
export function suggestBounty(yearlyNetSavings: number): number {
  if (yearlyNetSavings <= 0) return 0;
  return Math.round((yearlyNetSavings * 0.3) / 100) * 100;
}

// The yearly cost of this task at which the robot pays for itself within
// `months`. Lets the agent say "this only pays off if mowing costs you over $X".
export function breakEvenAnnualCost(input: Omit<RoiInput, "currentAnnualCost">, months = 24): number | null {
  if (input.automationShare <= 0) return null;
  const neededNetSavings = (input.robotPrice * 12) / months;
  return Math.round((neededNetSavings + input.yearlyOpex) / input.automationShare);
}

// The longer view for an owner deciding on a robot: what it costs and saves over its life,
// and what that's worth in today's money.
//   NPV = -C0 + sum over t = 1..N of (B - O) / (1 + r)^t
//   TCO = C0 + N * O            (price plus every year's running cost)
//   ROI = (N * (B - O) - C0) / C0
// B = yearly labor saved, O = yearly running cost, C0 = price, r = discount rate, N = years.
export const LIFE_YEARS = 5;
export const DISCOUNT_RATE = 0.08;

export type Lifetime = {
  years: number;
  ratePct: number;
  upfront: number;
  totalCost: number; // TCO
  totalSavings: number; // labor saved minus running cost, all years
  npv: number;
  roiPct: number | null; // null when the robot is free (no price to divide by)
};

export function lifetimeValue(
  input: { robotPrice: number; yearlyLaborSaved: number; yearlyOpex: number },
  years = LIFE_YEARS,
  rate = DISCOUNT_RATE,
): Lifetime {
  const net = input.yearlyLaborSaved - input.yearlyOpex;
  let npv = -input.robotPrice;
  for (let t = 1; t <= years; t++) npv += net / (1 + rate) ** t;
  const totalSavings = net * years;
  return {
    years,
    ratePct: Math.round(rate * 100),
    upfront: Math.round(input.robotPrice),
    totalCost: Math.round(input.robotPrice + input.yearlyOpex * years),
    totalSavings: Math.round(totalSavings),
    npv: Math.round(npv),
    roiPct: input.robotPrice > 0 ? Math.round(((totalSavings - input.robotPrice) / input.robotPrice) * 100) : null,
  };
}

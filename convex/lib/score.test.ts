import { describe, expect, it } from "vitest";
import { matchScore, scoreParts } from "./score";
import { lifetimeValue } from "./roi";
import { poolByTask } from "./pool";
import { rankRobots, type Intent, type RobotFacts } from "./decide";

const meets = { requirement: "Max slope at least 25", status: "meets" as const, mandatory: true };
const base = { fit: [meets], requirementCount: 1, sourcedSpecs: 1, priceListed: true, priceSourced: true, price: 30000, budget: null, paybackMonths: 12, hasRoi: true };

describe("match score S = F(0.4C + 0.3R + 0.3E)", () => {
  it("weights cost, requirements and evidence", () => {
    const p = scoreParts(base);
    expect(p).toEqual({ fit: 1, cost: 0.8, requirements: 1, evidence: 1 });
    expect(Math.round(matchScore(p))).toBe(92); // 100 * (0.32 + 0.3 + 0.3)
  });
  it("is 0 when a must-have is missed", () => {
    const p = scoreParts({ ...base, fit: [{ ...meets, status: "misses" }] });
    expect(p.fit).toBe(0);
    expect(matchScore(p)).toBe(0);
  });
  it("counts only vendor-page figures as evidence", () => {
    expect(scoreParts({ ...base, sourcedSpecs: 0, priceSourced: false }).evidence).toBe(0);
    expect(scoreParts({ ...base, sourcedSpecs: 0 }).evidence).toBe(0.5);
  });
  it("leaves evidence unchanged when the caller doesn't track automation-share sourcing (back-compat)", () => {
    expect(scoreParts(base).evidence).toBe(1);
  });
  it("counts a vendor-stated automation share as evidence, and a guessed one as missing evidence", () => {
    expect(scoreParts({ ...base, automationShareSourced: true }).evidence).toBe(1);
    expect(scoreParts({ ...base, automationShareSourced: false }).evidence).toBeLessThan(1);
  });
  it("can't reach a perfect 100 score once the automation share is flagged as a guess, even with a perfect payback", () => {
    const fastPayback = { ...base, paybackMonths: 0 }; // cost component maxes out at 1
    expect(matchScore(scoreParts({ ...fastPayback, automationShareSourced: true }))).toBe(100);
    expect(matchScore(scoreParts({ ...fastPayback, automationShareSourced: false }))).toBeLessThan(100);
  });
  it("scores cost from payback, then budget, else neutral", () => {
    expect(scoreParts({ ...base, paybackMonths: null }).cost).toBe(0); // never pays back
    expect(scoreParts({ ...base, hasRoi: false, paybackMonths: null, budget: 60000 }).cost).toBe(0.75);
    expect(scoreParts({ ...base, hasRoi: false, paybackMonths: null, budget: 20000 }).cost).toBe(0);
    expect(scoreParts({ ...base, priceListed: false, hasRoi: false }).cost).toBe(0.5);
  });
});

describe("lifetime value: NPV, TCO, ROI", () => {
  it("discounts each year's net savings", () => {
    const l = lifetimeValue({ robotPrice: 40000, yearlyLaborSaved: 30000, yearlyOpex: 3000 }, 5, 0.08);
    // 27000 a year for 5 years at 8% is worth 107,803 today
    expect(l).toEqual({ years: 5, ratePct: 8, upfront: 40000, totalCost: 55000, totalSavings: 135000, npv: 67803, roiPct: 238 });
  });
  it("goes negative when running costs eat the savings", () => {
    expect(lifetimeValue({ robotPrice: 10000, yearlyLaborSaved: 2000, yearlyOpex: 3000 }).npv).toBeLessThan(-10000);
  });
  it("has no ROI percentage for a free robot", () => {
    expect(lifetimeValue({ robotPrice: 0, yearlyLaborSaved: 1000, yearlyOpex: 0 }).roiPct).toBeNull();
  });
});

describe("pooled bounty demand B_k", () => {
  it("adds up pledges per task across businesses", () => {
    const pools = poolByTask([
      { requestId: "a", taskKey: "mowing", pledged: 5000, goal: 20000 },
      { requestId: "b", taskKey: "mowing", pledged: 7000, goal: 30000 },
      { requestId: "b", taskKey: "edging", pledged: 1000, goal: 5000 },
      { requestId: "c", pledged: 999, goal: 1 }, // no task: not pooled
    ]);
    expect(pools.get("mowing")).toEqual({ taskKey: "mowing", businesses: 2, bounties: 2, pledged: 12000, goal: 50000 });
    expect(pools.get("edging")?.businesses).toBe(1);
    expect(pools.size).toBe(2);
  });
});

describe("rankRobots with the match score", () => {
  const intent: Intent = { task: "mowing", annualTaskCost: 60000, budget: null, requirements: [{ name: "max_slope_deg", op: "atLeast", value: 25, mandatory: true }] };
  const vendor: RobotFacts = { _id: "v", name: "Vendor", price: 30000, priceStatus: "listed", yearlyOpex: 2000, automationShare: 0.5, specs: [{ name: "max_slope_deg", value: 35 }] };
  const fictional: RobotFacts = { _id: "f", name: "Fictional", price: 30000, yearlyOpex: 2000, automationShare: 0.5, slopeLimitDeg: 35 };
  it("ranks the vendor-sourced robot above an identical fictional one, with lifetime figures", () => {
    const [top, second] = rankRobots(intent, [fictional, vendor]);
    expect(top.robotId).toBe("v");
    expect(top.score).toBeGreaterThan(second.score);
    expect(top.lifetime).toMatchObject({ years: 5, upfront: 30000, totalCost: 40000, totalSavings: 140000 });
  });
});

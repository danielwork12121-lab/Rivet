import { describe, expect, it } from "vitest";
import { compatibilityOf, fitCheck, nextAction, rankRobots, type Intent, type RobotFacts } from "./decide";
import { pickUrls } from "./discovery";

const flatMower: RobotFacts = {
  _id: "flat", name: "Flat mower", price: 20000, yearlyOpex: 1000, automationShare: 0.6,
  specs: [{ name: "max_slope_deg", value: 15 }, { name: "runtime_hours", value: 6 }],
};
const slopeMower: RobotFacts = {
  _id: "slope", name: "Slope mower", price: 40000, yearlyOpex: 3000, automationShare: 0.6,
  specs: [{ name: "max_slope_deg", value: 30 }],
};
const quoteOnly: RobotFacts = {
  _id: "quote", name: "Ask us mower", price: 0, priceStatus: "quote_only", yearlyOpex: 0, automationShare: 0.5,
};

const hills: Intent = {
  task: "mowing", annualTaskCost: 90000, budget: null,
  requirements: [
    { name: "max_slope_deg", op: "atLeast", value: 25, mandatory: true },
    { name: "runtime_hours", op: "atLeast", value: 4, mandatory: false },
  ],
};

describe("fitCheck", () => {
  it("marks each requirement meets, misses or unknown", () => {
    expect(fitCheck(hills, flatMower).map((f) => f.status)).toEqual(["misses", "meets"]);
    expect(fitCheck(hills, slopeMower).map((f) => f.status)).toEqual(["meets", "unknown"]);
  });
  it("treats a quote-only price as unknown against a budget", () => {
    expect(fitCheck({ ...hills, requirements: [], budget: 30000 }, quoteOnly)[0].status).toBe("unknown");
  });
});

describe("rankRobots", () => {
  it("puts the robot that meets the mandatory requirement first", () => {
    const ranked = rankRobots(hills, [flatMower, slopeMower, quoteOnly]);
    expect(ranked[0].robotId).toBe("slope");
    expect(ranked[0].paybackMonths).toBe(9); // 40000 / (54000 - 3000) * 12 = 9.4
  });
  it("gives no ROI for a robot without a listed price", () => {
    const ranked = rankRobots(hills, [quoteOnly]);
    expect(ranked[0].paybackMonths).toBeNull();
    expect(ranked[0].breakEvenAnnualCost).toBeNull();
  });

  // Test F from the Cal Hacks demo review: a robot missing both its price AND its productivity
  // specs must never have either fabricated -- no invented price, no invented payback, and no
  // requirement silently marked "meets" for a spec the robot simply doesn't state.
  it("Test F: a robot with no price and no stated productivity specs never gets a fabricated ROI or fit", () => {
    const noDataRobot: RobotFacts = {
      _id: "mystery", name: "Unspecified mower", price: 0, priceStatus: "quote_only", yearlyOpex: 0,
      automationShare: 0.15, automationShareEstimated: true, environments: ["outdoor"],
      // No `specs` at all -- coverage, runtime, everything is unstated.
    };
    const [top] = rankRobots(hills, [noDataRobot]);
    expect(top.paybackMonths).toBeNull();
    expect(top.yearlyNetSavings).toBeNull();
    expect(top.breakEvenAnnualCost).toBeNull();
    expect(top.lifetime).toBeNull();
    // The mandatory slope requirement has nothing to check it against: "unknown", not a silent
    // "meets" and not a disqualifying "misses" either.
    expect(top.fit.find((f) => f.requirement.includes("Max slope"))?.status).toBe("unknown");
    expect(top.score).toBeLessThan(100);
  });
});

describe("nextAction", () => {
  it("shows matches when the best robot meets every must-have", () => {
    expect(nextAction(hills, rankRobots(hills, [slopeMower])).kind).toBe("show_matches");
  });
  it("suggests a bounty listing the gaps when nothing meets them", () => {
    const next = nextAction(hills, rankRobots(hills, [flatMower]));
    expect(next).toEqual({ kind: "suggest_bounty", gaps: ["Max slope (degrees) at least 25"] });
  });
  it("suggests a bounty when there are no robots at all", () => {
    expect(nextAction(hills, []).kind).toBe("suggest_bounty");
  });
  it("asks for the yearly cost when it's missing", () => {
    const noCost = { ...hills, annualTaskCost: null };
    expect(nextAction(noCost, rankRobots(noCost, [slopeMower]))).toEqual({ kind: "ask", field: "annualTaskCost" });
  });
});

// Regression coverage for the two bugs the Cal Hacks demo review found: an indoor floor-cleaning
// robot recommended for outdoor hazard clearing (Test D), and a small residential mower scoring a
// perfect, unrealistically profitable match on a commercial job (mirrors the Mammotion LUBA case).
describe("compatibilityOf: hard engineering gate", () => {
  const outdoorJob: Intent = { task: "vegetation maintenance", annualTaskCost: 188000, budget: null, requirements: [] };
  const indoorJob: Intent = { task: "floor cleaning", annualTaskCost: 40000, budget: null, requirements: [] };
  const indoorRobot: RobotFacts = {
    _id: "agibot", name: "Indoor floor robot", price: 5000, yearlyOpex: 500, automationShare: 0.5,
    environments: ["indoor"],
  };
  const outdoorRobot: RobotFacts = {
    _id: "mower", name: "Outdoor mower", price: 20000, yearlyOpex: 2000, automationShare: 0.6,
    environments: ["outdoor"],
  };
  const noEnvRobot: RobotFacts = { _id: "x", name: "Unknown-environment robot", price: 1000, yearlyOpex: 0, automationShare: 0.3 };

  it("rejects an indoor-only robot for a clearly outdoor task (Test D)", () => {
    expect(compatibilityOf(outdoorJob, indoorRobot)).toBe("incompatible");
  });
  it("rejects an outdoor-only robot for a clearly indoor task", () => {
    expect(compatibilityOf(indoorJob, outdoorRobot)).toBe("incompatible");
  });
  it("allows a matching environment through as compatible", () => {
    expect(compatibilityOf(outdoorJob, outdoorRobot)).toBe("compatible");
  });
  it("marks a robot with no recorded environment as insufficient_info, never a silent pass", () => {
    expect(compatibilityOf(outdoorJob, noEnvRobot)).toBe("insufficient_info");
  });
  it("downgrades to conditionally_compatible when the automation share is only a guess", () => {
    expect(compatibilityOf(outdoorJob, { ...outdoorRobot, automationShareEstimated: true })).toBe("conditionally_compatible");
  });

  it("excludes an incompatible robot from rankRobots entirely, not just scoring it low", () => {
    const ranked = rankRobots(outdoorJob, [indoorRobot, outdoorRobot]);
    expect(ranked.map((r) => r.robotId)).toEqual(["mower"]);
  });

  it("never gives a perfect 100 score to a robot whose automation share is a guessed default, even with no stated requirements to miss", () => {
    // Mirrors the Mammotion LUBA case: a cheap residential-class mower, no stated engineering
    // requirements (so nothing to "miss"), but the labor-saved percentage was never vendor-stated.
    const commercialJob: Intent = { task: "mowing", annualTaskCost: 188000, budget: null, requirements: [] };
    const residentialMower: RobotFacts = {
      _id: "luba", name: "Residential mower", price: 1799, priceStatus: "listed", yearlyOpex: 150,
      automationShare: 0.15, automationShareEstimated: true, environments: ["outdoor"],
    };
    const [top] = rankRobots(commercialJob, [residentialMower]);
    expect(top.score).toBeLessThan(100);
    expect(top.compatibility).toBe("conditionally_compatible");
    expect(top.roiConfidence).toBe("estimated");
    // The payback is still fast for a $1,799 robot against a $188k task cost -- that's an economics
    // problem this unit test can't fix on its own (it needs fleet-sizing data the catalog doesn't
    // have), but the score and confidence flags now say so instead of claiming a perfect match.
    expect(top.paybackMonths).not.toBe(0);
  });
});

// Test C from the Cal Hacks demo review: a large commercial operation / fleet-sizing job. The
// catalog has no "total area" or "crew count" field to check a robot's coverage spec against, so
// per the spec's fallback ("else don't assume one cheap robot replaces a crew") this must flag the
// uncertainty rather than silently applying a single unit's automation share to the whole job.
describe("rankRobots: fleet-sizing caveat for large commercial jobs (Test C)", () => {
  const vendorSourcedRobot: RobotFacts = {
    _id: "fleet-robot", name: "Commercial mower", price: 15000, priceStatus: "listed", yearlyOpex: 1200,
    automationShare: 0.4, automationShareEstimated: false, environments: ["outdoor"],
  };
  const largeJob: Intent = { task: "mowing", annualTaskCost: 400000, budget: null, requirements: [] };
  const smallJob: Intent = { task: "mowing", annualTaskCost: 60000, budget: null, requirements: [] };

  it("downgrades roiConfidence and adds a caveat for a large-scale job, even with a vendor-sourced automation share", () => {
    const [top] = rankRobots(largeJob, [vendorSourcedRobot]);
    expect(top.roiConfidence).toBe("estimated");
    expect(top.assumptions.some((a) => a.includes("Assumed to replace"))).toBe(true);
    expect(top.assumptions.some((a) => /fleet|units a job this size/.test(a))).toBe(true);
  });

  it("leaves a small job's vendor-sourced robot alone: no caveat, no confidence downgrade", () => {
    const [top] = rankRobots(smallJob, [vendorSourcedRobot]);
    expect(top.roiConfidence).toBe("vendor_sourced");
    expect(top.assumptions.some((a) => a.includes("Assumed to replace"))).toBe(false);
  });

  it("never fabricates a fleet count -- the caveat is words, not an invented number of units", () => {
    const [top] = rankRobots(largeJob, [vendorSourcedRobot]);
    expect(top.assumptions.join(" ")).not.toMatch(/\d+\s*(units|robots) needed/i);
  });

  it("doesn't touch engineering compatibility: the robot is still a physically compatible match", () => {
    const [top] = rankRobots(largeJob, [vendorSourcedRobot]);
    expect(top.compatibility).toBe("compatible");
  });

  it("pulls the score down relative to the same robot on a small job, since evidence now counts the share as unverified for this job's scale", () => {
    const [bigJobTop] = rankRobots(largeJob, [vendorSourcedRobot]);
    const [smallJobTop] = rankRobots(smallJob, [vendorSourcedRobot]);
    expect(bigJobTop.scoreParts.evidence).toBeLessThan(smallJobTop.scoreParts.evidence);
  });
});

describe("pickUrls", () => {
  it("keeps one page per site and skips social and shopping sites", () => {
    const urls = pickUrls([
      { organicResults: [{ url: "https://www.youtube.com/watch?v=1" }, { url: "https://vendor-a.com/x1" }, { url: "https://vendor-a.com/x2" }] },
      { organicResults: [{ url: "https://shop.amazon.com/item" }, { url: "https://vendor-b.com/robot" }, { url: "not a url" }] },
    ]);
    expect(urls).toEqual(["https://vendor-a.com/x1", "https://vendor-b.com/robot"]);
  });
});

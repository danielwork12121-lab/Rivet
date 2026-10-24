import { describe, expect, it } from "vitest";
import { fitCheck, nextAction, rankRobots, type Intent, type RobotFacts } from "./decide";
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

describe("pickUrls", () => {
  it("keeps one page per site and skips social and shopping sites", () => {
    const urls = pickUrls([
      { organicResults: [{ url: "https://www.youtube.com/watch?v=1" }, { url: "https://vendor-a.com/x1" }, { url: "https://vendor-a.com/x2" }] },
      { organicResults: [{ url: "https://shop.amazon.com/item" }, { url: "https://vendor-b.com/robot" }, { url: "not a url" }] },
    ]);
    expect(urls).toEqual(["https://vendor-a.com/x1", "https://vendor-b.com/robot"]);
  });
});

import { describe, expect, it } from "vitest";
import { bountyTaskKey, cleanSteps, normalizeShares, stepCost, stepsToSearch, stepVerdict, workflowSummary } from "./workflow";

describe("normalizeShares", () => {
  it("keeps proportions and always adds up to 100", () => {
    expect(normalizeShares([50, 30, 20])).toEqual([50, 30, 20]);
    expect(normalizeShares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(normalizeShares([60, 60])).toEqual([50, 50]);
    expect(normalizeShares([0, 0, 0, 0]).reduce((a, b) => a + b)).toBe(100);
    expect(normalizeShares([-5, NaN, 10])).toEqual([0, 0, 100]);
    expect(normalizeShares([])).toEqual([]);
  });
});

describe("cleanSteps", () => {
  it("caps at seven steps, trims text and normalises tasks", () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({
      name: `  Step ${i} `, sharePct: 10, verdict: "automatable" as const, why: " because ", task: " Lawn  Mowing ", searchPhrase: " robot mower ",
    }));
    const steps = cleanSteps(raw);
    expect(steps).toHaveLength(7);
    expect(steps[0]).toMatchObject({ name: "Step 0", why: "because", task: "lawn mowing", searchPhrase: "robot mower", aiVerdict: "automatable" });
    expect(steps.reduce((a, s) => a + s.sharePct, 0)).toBe(100);
  });
});

describe("stepsToSearch", () => {
  it("picks the biggest steps a robot might do, never 'person' steps", () => {
    const steps = [
      { sharePct: 10, aiVerdict: "automatable" as const },
      { sharePct: 40, aiVerdict: "person" as const },
      { sharePct: 25, aiVerdict: "possible" as const },
      { sharePct: 15, aiVerdict: "automatable" as const },
      { sharePct: 10, aiVerdict: "automatable" as const },
    ];
    expect(stepsToSearch(steps)).toEqual([2, 3, 0]);
    expect(stepsToSearch(steps, 1)).toEqual([2]);
  });
});

describe("stepCost", () => {
  it("is the step's share of the job's labor, or null without a labor cost", () => {
    expect(stepCost(80000, 25)).toBe(20000);
    expect(stepCost(null, 25)).toBeNull();
    expect(stepCost(80000, 150)).toBe(80000);
  });
});

describe("stepVerdict", () => {
  const done = (pickCount: number, kind: string) => ({ status: "done" as const, pickCount, next: { kind } });
  it("is decided by code from the search result", () => {
    expect(stepVerdict("person", done(3, "show_matches"))).toBe("person");
    expect(stepVerdict("automatable", null)).toBe("unchecked");
    expect(stepVerdict("automatable", { status: "searching", pickCount: 0, next: null })).toBe("checking");
    expect(stepVerdict("automatable", { status: "failed", pickCount: 0, next: null })).toBe("failed");
    expect(stepVerdict("possible", done(2, "show_matches"))).toBe("today");
    expect(stepVerdict("automatable", done(2, "ask"))).toBe("today");
    expect(stepVerdict("automatable", done(2, "suggest_bounty"))).toBe("possible");
    expect(stepVerdict("automatable", done(0, "suggest_bounty"))).toBe("possible");
    expect(stepVerdict("automatable", { ...done(0, "suggest_bounty"), searchSkipped: true })).toBe("skipped");
  });
});

describe("workflowSummary", () => {
  it("adds up savings from the steps a robot can do today", () => {
    expect(workflowSummary([
      { verdict: "today", bestSavings: 30000 },
      { verdict: "today", bestSavings: 22000 },
      { verdict: "possible", bestSavings: null },
      { verdict: "person", bestSavings: null },
    ])).toEqual({ steps: 4, automatable: 2, bountyCandidates: 1, checking: 0, yearlySavings: 52000 });
    expect(workflowSummary([{ verdict: "today", bestSavings: null }]).yearlySavings).toBeNull();
  });
});

describe("bountyTaskKey", () => {
  it("makes a valid bounty task key", () => {
    expect(bountyTaskKey("Gutter Cleaning")).toBe("gutter-cleaning");
    expect(bountyTaskKey("3d scanning!")).toBe("d-scanning");
    expect(bountyTaskKey("!!!")).toBe("custom-task");
    expect(bountyTaskKey("a".repeat(29) + " b c")).toMatch(/^[a-z][a-z0-9_-]{0,29}$/);
  });
});

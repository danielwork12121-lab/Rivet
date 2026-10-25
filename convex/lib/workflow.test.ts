import { describe, expect, it } from "vitest";
import { bountyTaskKey, cleanSteps, normalizeShares, orderStages, pathShares, stepCost, stepsToSearch, stepVerdict, workflowSummary } from "./workflow";

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

describe("stages: A -> (B1 or B2) -> C", () => {
  const step = (name: string, stage: number | null | undefined, sharePct = 20) => ({
    name, stage, sharePct, verdict: "automatable" as const, why: "w", task: name, searchPhrase: name,
  });
  it("orders by stage, renumbers from 1, keeps options together", () => {
    const out = orderStages([step("C", 7), step("A", 2), step("B2", 5), step("B1", 5)]);
    expect(out.map((s) => [s.name, s.stage])).toEqual([["A", 1], ["B2", 2], ["B1", 2], ["C", 3]]);
  });
  it("keeps a step without a stage where it was listed", () => {
    const out = orderStages([step("A", 1), step("loose", null), step("B", 2)]);
    expect(out.map((s) => [s.name, s.stage])).toEqual([["A", 1], ["loose", 2], ["B", 3]]);
  });
  it("allows at most three options per stage", () => {
    expect(orderStages(["a", "b", "c", "d"].map((n) => step(n, 1)))).toHaveLength(3);
  });
  it("makes one path add up to 100; other options scale the same way", () => {
    // A 30, B1 50 or B2 25, C 20 -> path A + B1 + C = 100
    expect(pathShares([{ sharePct: 30, stage: 1 }, { sharePct: 50, stage: 2 }, { sharePct: 25, stage: 2 }, { sharePct: 20, stage: 3 }])).toEqual([30, 50, 25, 20]);
    const steps = cleanSteps([step("A", 1, 60), step("B1", 2, 60), step("B2", 2, 30), step("C", 3, 80)]);
    expect(steps.map((s) => [s.name, s.stage, s.sharePct])).toEqual([["A", 1, 30], ["B1", 2, 30], ["B2", 2, 15], ["C", 3, 40]]);
  });
  it("counts savings once per stage: the best option", () => {
    const sm = workflowSummary([
      { verdict: "today", bestSavings: 10000, stage: 1 },
      { verdict: "today", bestSavings: 8000, stage: 2 },
      { verdict: "today", bestSavings: 12000, stage: 2 },
    ]);
    expect(sm).toMatchObject({ automatable: 3, yearlySavings: 22000 });
  });
});

// The workflow breakdown: plain functions over what the AI split a job into. Claude
// names the steps and guesses each one's share of the week; code decides which steps
// to search, what each step costs, and the verdict the page shows.
import { normalizeTask } from "./decide";

export type AiVerdict = "automatable" | "possible" | "person";

// What the page shows for a step:
//   today     a robot was found and meets every must-have
//   possible  could be automated, but no product fits yet: a bounty candidate
//   person    needs a person (the AI's call; never searched)
//   checking  a search is running
//   unchecked not searched yet (only the biggest steps are searched up front)
//   failed    the search hit an error
export type StepVerdict = "today" | "possible" | "person" | "checking" | "unchecked" | "failed";

export const MAX_STEPS = 7;
export const SEARCH_CAP = 3; // searches started per breakdown

export type RawStep = {
  name: string;
  sharePct: number;
  verdict: AiVerdict;
  why: string;
  task: string;
  searchPhrase: string;
};

// Whole-number shares that add up to 100, keeping the AI's proportions.
export function normalizeShares(shares: number[]): number[] {
  const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (shares.length === 0) return [];
  if (total === 0) return evenSplit(shares.length);
  const exact = clean.map((s) => (s / total) * 100);
  const out = exact.map(Math.floor);
  // Hand the leftover points to the largest remainders.
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  const leftover = 100 - out.reduce((a, b) => a + b, 0);
  for (let k = 0; k < leftover; k++) out[order[k % order.length][1]]++;
  return out;
}

function evenSplit(n: number): number[] {
  const out = Array(n).fill(Math.floor(100 / n));
  const leftover = 100 - out[0] * n;
  for (let k = 0; k < leftover; k++) out[k]++;
  return out;
}

// Cleans the AI's steps: at most MAX_STEPS, trimmed text, normalised tasks, shares summing to 100.
export function cleanSteps(raw: RawStep[]) {
  const steps = raw.filter((s) => s.name.trim()).slice(0, MAX_STEPS);
  const shares = normalizeShares(steps.map((s) => s.sharePct));
  return steps.map((s, i) => ({
    name: s.name.trim().slice(0, 80),
    sharePct: shares[i],
    aiVerdict: s.verdict,
    why: s.why.trim().slice(0, 300),
    task: normalizeTask(s.task).slice(0, 40),
    searchPhrase: s.searchPhrase.trim().slice(0, 80),
  }));
}

// Which steps to search first: the biggest steps a robot might do, at most `cap`.
export function stepsToSearch(steps: { sharePct: number; aiVerdict: AiVerdict }[], cap = SEARCH_CAP): number[] {
  return steps
    .map((s, i) => ({ ...s, i }))
    .filter((s) => s.aiVerdict !== "person")
    .sort((a, b) => b.sharePct - a.sharePct || a.i - b.i)
    .slice(0, cap)
    .map((s) => s.i);
}

// What one step costs a year: its share of the job's labor.
export function stepCost(laborCost: number | null, sharePct: number): number | null {
  if (laborCost === null || !(laborCost > 0)) return null;
  return Math.round((laborCost * Math.max(0, Math.min(100, sharePct))) / 100);
}

type MatchSummary = {
  status: "reading" | "searching" | "ranked" | "done" | "failed";
  pickCount: number;
  next: { kind: string } | null;
} | null;

export function stepVerdict(aiVerdict: AiVerdict, match: MatchSummary): StepVerdict {
  if (aiVerdict === "person") return "person";
  if (!match) return "unchecked";
  if (match.status === "failed") return "failed";
  if (match.status !== "done") return "checking";
  if (match.pickCount > 0 && match.next?.kind !== "suggest_bounty") return "today";
  return "possible";
}

// The header line: how many steps can be automated today and what that saves a year.
export function workflowSummary(steps: { verdict: StepVerdict; bestSavings: number | null }[]) {
  const today = steps.filter((s) => s.verdict === "today");
  const savings = today.reduce((sum, s) => sum + Math.max(0, s.bestSavings ?? 0), 0);
  return {
    steps: steps.length,
    automatable: today.length,
    bountyCandidates: steps.filter((s) => s.verdict === "possible").length,
    checking: steps.filter((s) => s.verdict === "checking").length,
    yearlySavings: today.some((s) => s.bestSavings !== null) ? Math.round(savings) : null,
  };
}

// A bounty taskKey from a step's task: starts with a letter, letters/digits/-/_ only, max 30.
export function bountyTaskKey(task: string): string {
  const slug = normalizeTask(task).replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 30).replace(/-+$/, "");
  return slug || "custom-task";
}

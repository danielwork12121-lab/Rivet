// Turns what the AI read into data we trust. Everything here is plain code:
// numbers are checked against the source text and units are converted by
// lib/specs.ts, so a mistake by the AI becomes "unknown" instead of a wrong fact.
import { normalizeTask, type Intent, type Requirement } from "./decide";
import { isSpecName, toCanonical, type SpecName } from "./specs";
import { numberAppears, verifyEvidence, type Evidence } from "./verify";
import { verifiedImage } from "./images";

// ---------- The operator's message (fast layer) ----------

export type RawIntent = {
  task: string;
  searchPhrase: string;
  annualTaskCost: number | null;
  budget: number | null;
  requirements: { name: SpecName; op: "atLeast" | "atMost"; value: number; unit: string; mandatory: boolean }[];
};

// Keeps only numbers the operator actually wrote, converted to canonical units.
// `knownCost` (from the intake form) wins over anything read from the text.
export function cleanIntent(raw: RawIntent, operatorText: string, knownCost?: number) {
  const written = (n: number | null) => (n !== null && numberAppears(n, operatorText) ? n : null);
  const requirements: Requirement[] = [];
  for (const r of raw.requirements) {
    if (!numberAppears(r.value, operatorText)) continue;
    const value = toCanonical(r.name, r.value, r.unit);
    if (value !== null) requirements.push({ name: r.name, op: r.op, value, mandatory: r.mandatory });
  }
  return {
    task: normalizeTask(raw.task),
    searchPhrase: raw.searchPhrase.trim().slice(0, 80),
    annualTaskCost: knownCost ?? written(raw.annualTaskCost),
    budget: written(raw.budget),
    requirements,
  } satisfies Intent & { searchPhrase: string };
}

// ---------- A vendor page (crawl + extract) ----------

export type RawRobotPage = {
  isRobotProduct: boolean;
  name: string;
  vendor: string;
  priceOnRequest: boolean;
  price: Evidence;
  yearlyRunningCost: Evidence;
  laborSavedPercent: Evidence;
  specs: { name: string; value: number; unit: string; quote: string }[];
  environments: string[];
  imageUrl?: string | null; // a photo URL linked in the page text
};

const DEFAULT_OPEX_SHARE = 0.08; // running cost per year as a share of price, when the page doesn't say
const DEFAULT_AUTOMATION = 0.5; // share of the task's labor replaced, when the page doesn't say

// A robots-table row from one page, or null if the page isn't a robot product.
export function robotFromPage(raw: RawRobotPage, page: { url: string; markdown: string; imageUrl?: string }, task: string) {
  if (!raw.isRobotProduct || !raw.name.trim()) return null;
  const assumptions: string[] = [];

  const price = verifyEvidence(raw.price, page.markdown).value;
  const listed = price !== null && price > 0;

  const opex = verifyEvidence(raw.yearlyRunningCost, page.markdown).value;
  let yearlyOpex: number;
  if (opex !== null) yearlyOpex = Math.round(opex);
  else {
    yearlyOpex = listed ? Math.round(price * DEFAULT_OPEX_SHARE) : 0;
    assumptions.push(`Running cost estimated at ${DEFAULT_OPEX_SHARE * 100}% of the price per year`);
  }

  const saved = verifyEvidence(raw.laborSavedPercent, page.markdown).value;
  let automationShare: number;
  if (saved !== null && saved > 0 && saved <= 100) automationShare = saved / 100;
  else {
    automationShare = DEFAULT_AUTOMATION;
    assumptions.push(`Assumed to replace ${DEFAULT_AUTOMATION * 100}% of the task's labor`);
  }

  const specs = [];
  for (const s of raw.specs) {
    if (!isSpecName(s.name)) continue;
    const checked = verifyEvidence({ value: s.value, unit: s.unit, quote: s.quote }, page.markdown);
    if (checked.value === null) continue;
    const value = toCanonical(s.name, checked.value, s.unit);
    if (value !== null) specs.push({ name: s.name, value, quote: s.quote.slice(0, 300), sourceUrl: page.url });
  }

  return {
    name: raw.name.trim().slice(0, 120),
    vendor: raw.vendor.trim().slice(0, 120) || new URL(page.url).hostname,
    task: normalizeTask(task),
    url: page.url,
    price: listed ? price : 0,
    priceStatus: listed ? ("listed" as const) : ("quote_only" as const),
    yearlyOpex,
    automationShare,
    environments: raw.environments.slice(0, 10),
    specs,
    assumptions,
    ...imageOf(raw, page),
  };
}

// The robot's photo: one the AI found linked in the page text, else the page's own main image.
function imageOf(raw: RawRobotPage, page: { url: string; markdown: string; imageUrl?: string }) {
  const imageUrl = verifiedImage(raw.imageUrl, page) ?? page.imageUrl;
  return imageUrl ? { imageUrl } : {};
}

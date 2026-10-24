// Turns what the AI read into data we trust. Everything here is plain code:
// numbers are checked against the source text and units are converted by
// lib/specs.ts, so a mistake by the AI becomes "unknown" instead of a wrong fact.
import { normalizeTask, type Intent, type Requirement } from "./decide.js";
import { isSpecName, toCanonical, type SpecName } from "./specs.js";
import { numberAppears, verifyEvidence, type Evidence } from "./verify.js";

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
  price: Evidence; // one-time purchase price
  subscription: Evidence; // recurring price (subscription, lease, robot-as-a-service)
  subscriptionPeriod: "month" | "year" | null;
  yearlyRunningCost: Evidence;
  laborSavedPercent: Evidence;
  specs: { name: string; value: number; unit: string; quote: string }[];
  environments: string[];
};

export type Pricing =
  | { model: "purchase"; purchasePrice: number; subscription: Subscription | null; note: string; quote: string }
  | { model: "subscription"; purchasePrice: null; subscription: Subscription; note: string; quote: string }
  | { model: "none"; purchasePrice: null; subscription: null; note: string; quote: null };
type Subscription = { price: number; period: "month" | "year"; perYear: number; quote: string };

const DEFAULT_OPEX_SHARE = 0.08; // running cost per year as a share of price, when the page doesn't say
const DEFAULT_AUTOMATION = 0.5; // share of the task's labor replaced, when the page doesn't say
const NO_PRICE = "No public price available. Contact the vendor for a quote.";

// How the robot is paid for, from verified numbers only. A purchase price wins;
// otherwise a monthly or yearly subscription; otherwise "no public price".
export function pricingFrom(raw: RawRobotPage, markdown: string): Pricing {
  const price = verifyEvidence(raw.price, markdown).value;
  const subValue = verifyEvidence(raw.subscription, markdown).value;
  const subscription: Subscription | null =
    subValue !== null && subValue > 0 && raw.subscriptionPeriod && raw.subscription.quote
      ? {
          price: subValue,
          period: raw.subscriptionPeriod,
          perYear: Math.round(raw.subscriptionPeriod === "month" ? subValue * 12 : subValue),
          quote: raw.subscription.quote.slice(0, 300),
        }
      : null;
  const dollars = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  if (price !== null && price > 0) {
    return {
      model: "purchase", purchasePrice: price, subscription, quote: (raw.price.quote ?? "").slice(0, 300),
      note: `${dollars(price)} to buy` + (subscription ? `, plus ${dollars(subscription.price)} per ${subscription.period}` : ""),
    };
  }
  if (subscription) {
    return {
      model: "subscription", purchasePrice: null, subscription, quote: subscription.quote,
      note: `${dollars(subscription.price)} per ${subscription.period} (${dollars(subscription.perYear)} a year), no purchase price listed`,
    };
  }
  return { model: "none", purchasePrice: null, subscription: null, note: NO_PRICE, quote: null };
}

// One robot from one page, or null if the page isn't a robot product.
export function robotFromPage(raw: RawRobotPage, page: { url: string; markdown: string }, task: string) {
  if (!raw.isRobotProduct || !raw.name.trim()) return null;
  const assumptions: string[] = [];
  const pricing = pricingFrom(raw, page.markdown);

  // Yearly running cost: a stated one, else the subscription, else an estimate.
  const stated = verifyEvidence(raw.yearlyRunningCost, page.markdown).value;
  let yearlyOpex: number | null;
  if (pricing.model === "subscription") {
    yearlyOpex = pricing.subscription.perYear + Math.round(stated ?? 0);
  } else if (stated !== null) {
    yearlyOpex = Math.round(stated);
  } else if (pricing.model === "purchase" && pricing.subscription) {
    yearlyOpex = pricing.subscription.perYear;
  } else if (pricing.model === "purchase") {
    yearlyOpex = Math.round(pricing.purchasePrice * DEFAULT_OPEX_SHARE);
    assumptions.push(`Running cost estimated at ${DEFAULT_OPEX_SHARE * 100}% of the price per year`);
  } else {
    yearlyOpex = null; // no public price: nothing to estimate from
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
    pricing,
    yearlyOpex,
    automationShare,
    environments: raw.environments.slice(0, 10),
    specs,
    assumptions,
  };
}

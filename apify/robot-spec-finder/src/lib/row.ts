// Flattens one robot into a single dataset row, so the Apify table and CSV/Excel
// exports show every price and spec as its own column. All math here is code.
import type { robotFromPage } from "./extract.js";
import type { SpecName } from "./specs.js";

type Robot = NonNullable<ReturnType<typeof robotFromPage>>;

const SPEC_COLUMNS: Record<SpecName, string> = {
  runtime_hours: "runtimeHours",
  max_slope_deg: "maxSlopeDegrees",
  coverage_sqft_per_hour: "coverageSqftPerHour",
  payload_kg: "payloadKg",
  tank_liters: "tankLiters",
  reach_m: "reachMeters",
  width_m: "workingWidthMeters",
  weight_kg: "weightKg",
};

export function toDatasetRow(robot: Robot, checkedAt: string) {
  const { pricing } = robot;
  const sub = pricing.subscription;
  const specs: Record<string, number | null> = {};
  for (const [name, column] of Object.entries(SPEC_COLUMNS)) {
    specs[column] = robot.specs.find((s) => s.name === name)?.value ?? null;
  }
  return {
    name: robot.name,
    vendor: robot.vendor,
    task: robot.task,
    url: robot.url,
    priceAvailable: pricing.model !== "none",
    pricingModel: pricing.model, // "purchase" | "subscription" | "none"
    priceSummary: pricing.note,
    purchasePriceUsd: pricing.purchasePrice,
    subscriptionBilled: sub ? (sub.period === "month" ? "monthly" : "yearly") : null,
    monthlySubscriptionUsd: sub ? (sub.period === "month" ? sub.price : Math.round(sub.price / 12)) : null,
    annualSubscriptionUsd: sub ? sub.perYear : null,
    yearlyCostToRunUsd: robot.yearlyOpex,
    laborReplacedPercent: Math.round(robot.automationShare * 100),
    ...specs,
    priceQuote: pricing.quote, // the sentence on the page the price came from
    specSources: robot.specs.map((s) => `${s.name}: "${s.quote}"`).join(" | ") || null,
    estimates: robot.assumptions.join(" | ") || null,
    environments: robot.environments.join(", ") || null,
    specs: robot.specs, // full detail with a source URL per spec
    checkedAt,
  };
}

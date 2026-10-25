// Turns one row of the Robot Spec Finder Actor's dataset into a robots-table row.
// The Actor already checked every number against its page; this only reshapes it.

export type ActorRow = {
  name?: string;
  vendor?: string;
  url?: string;
  pricingModel?: "purchase" | "subscription" | "none";
  priceSummary?: string;
  purchasePriceUsd?: number | null;
  yearlyCostToRunUsd?: number | null;
  laborReplacedPercent?: number | null;
  estimates?: string | null;
  environments?: string | null;
  specs?: { name: string; value: number; quote: string; sourceUrl: string }[];
  imageUrl?: string | null;
};

export function robotFromActorRow(row: ActorRow, task: string) {
  if (!row.name || !row.url) return null;
  const model = row.pricingModel ?? "none";
  // Subscription-only robots cost nothing up front; the plan is in yearlyOpex.
  const price = model === "purchase" ? row.purchasePriceUsd ?? 0 : 0;
  const assumptions = row.estimates ? row.estimates.split(" | ") : [];
  if (model === "subscription" && row.priceSummary) assumptions.unshift(row.priceSummary);
  return {
    name: row.name,
    vendor: row.vendor ?? "",
    task,
    url: row.url,
    price,
    priceStatus: model === "none" ? ("quote_only" as const) : ("listed" as const),
    yearlyOpex: row.yearlyCostToRunUsd ?? 0,
    automationShare: (row.laborReplacedPercent ?? 0) / 100,
    environments: row.environments ? row.environments.split(", ") : [],
    specs: (row.specs ?? []).map(({ name, value, quote, sourceUrl }) => ({ name, value, quote, sourceUrl })),
    assumptions,
    ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
  };
}

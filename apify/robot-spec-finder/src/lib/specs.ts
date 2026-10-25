// The shared vocabulary for robot specs and operator requirements, so the two
// can be compared by code. Pages state units many ways ("2.5 acres/hr", "120
// min"); toCanonical converts them here instead of asking the AI to do math.

export const SPEC_NAMES = [
  "runtime_hours", // battery or shift runtime
  "max_slope_deg", // steepest slope it handles
  "coverage_sqft_per_hour", // area covered per hour (mowing, cleaning, spraying)
  "payload_kg", // weight it can carry
  "tank_liters", // liquid tank size (spraying, cleaning)
  "reach_m", // arm or boom reach
  "width_m", // cutting, cleaning or spray width
  "weight_kg", // robot's own weight
] as const;
export type SpecName = (typeof SPEC_NAMES)[number];

// Plain-language labels for the UI and for Claude's reasons.
export const SPEC_LABELS: Record<SpecName, string> = {
  runtime_hours: "Runtime (hours)",
  max_slope_deg: "Max slope (degrees)",
  coverage_sqft_per_hour: "Coverage (sq ft per hour)",
  payload_kg: "Payload (kg)",
  tank_liters: "Tank (liters)",
  reach_m: "Reach (m)",
  width_m: "Working width (m)",
  weight_kg: "Weight (kg)",
};

// unit (lower case, spaces removed) -> multiply by this to get the canonical unit
const FACTORS: Record<SpecName, Record<string, number>> = {
  runtime_hours: { h: 1, hr: 1, hrs: 1, hour: 1, hours: 1, min: 1 / 60, mins: 1 / 60, minutes: 1 / 60 },
  max_slope_deg: { deg: 1, "°": 1, degree: 1, degrees: 1 },
  coverage_sqft_per_hour: {
    "sqft/h": 1, "sqft/hr": 1, "ft²/h": 1, "ft2/h": 1, "squarefeet/hour": 1,
    "acres/h": 43560, "acre/h": 43560, "acres/hr": 43560, "acre/hr": 43560, "acres/hour": 43560,
    "m²/h": 10.7639, "m2/h": 10.7639, "sqm/h": 10.7639, "m²/hr": 10.7639,
  },
  payload_kg: { kg: 1, lb: 0.453592, lbs: 0.453592, pounds: 0.453592 },
  tank_liters: { l: 1, liter: 1, liters: 1, litre: 1, litres: 1, gal: 3.78541, gallon: 3.78541, gallons: 3.78541 },
  reach_m: { m: 1, cm: 0.01, ft: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254 },
  width_m: { m: 1, cm: 0.01, ft: 0.3048, feet: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254 },
  weight_kg: { kg: 1, lb: 0.453592, lbs: 0.453592, pounds: 0.453592 },
};

export function isSpecName(name: string): name is SpecName {
  return (SPEC_NAMES as readonly string[]).includes(name);
}

// Returns the value in the canonical unit, or null for a unit we don't know.
export function toCanonical(name: SpecName, value: number, unit: string): number | null {
  const u = unit.toLowerCase().replace(/\s+/g, "").replace("per", "/");
  if (name === "max_slope_deg" && (u === "%" || u === "percent")) {
    return round(Math.atan(value / 100) * (180 / Math.PI)); // a 100% grade is 45 degrees
  }
  const factor = FACTORS[name][u];
  return factor === undefined ? null : round(value * factor);
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

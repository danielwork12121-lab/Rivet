// Maps the task name the AI picked for a step onto the catalog's own task key, when the AI's
// name has no robots behind it. Plain code, no AI.
//
// Why this exists: robots are looked up by exact task string (robots.forTask). The AI is told to
// reuse a known task name when one fits, but for a job the catalog only recently started covering
// it invents its own ("aquatic weed removal" one run, "weed removal" the next), or picks a known
// one that only fits loosely ("inspection" for "survey the pond"). Either way the lookup came back
// empty and the step dead-ended. This only steps in when the AI's own name found nothing, and only
// for wording that clearly names one of these catalog tasks, so it never overrides a real hit.

export const WATER_SURVEY = "water survey";
export const AQUATIC_WEEDS = "aquatic weed removal";
export const DEBRIS_SKIMMING = "debris skimming";

// Words that put the work on or in a body of water.
const ON_WATER = /\b(ponds?|lakes?|lagoons?|wetlands?|marsh(es)?|reservoirs?|canals?|harbou?rs?|marinas?|rivers?|waterways?|aquatic|water(front|body)?|floating|shoreline|shore|dock|retention|detention|basin|estuar(y|ies))\b/;

// Survey first: "survey the pond for weeds" is a survey, not weed pulling.
const RULES: { task: string; words: RegExp }[] = [
  { task: WATER_SURVEY, words: /\b(survey(s|ing)?|inspect(ion|ing)?|mapping|bathymetr(y|ic)|sonar|monitor(ing)?|sampling|water quality)\b/ },
  { task: AQUATIC_WEEDS, words: /\b(weeds?|vegetation|plants?|hyacinth|duckweed|milfoil|hydrilla|lily|lilies|reeds?|algae|biomass|harvest(er|ing)?|muck)\b/ },
  { task: DEBRIS_SKIMMING, words: /\b(debris|trash|litter|garbage|waste|plastics?|skim(s|mer|ming)?|rubbish|flotsam)\b/ },
];

const WATER_WORDS = /\b(skim(mer|ming)?|aquatic|duckweed|hyacinth|milfoil|bathymetr(y|ic))\b/;

// The catalog task for this step, or null when no rule clearly applies. `texts` are, in order of
// trust, the AI's task name, then its search phrase (and/or the step's name). The water context may
// come from any of them; the task is decided by the first text that names one, so the AI's own
// task name wins over a loosely worded search phrase.
export function catalogTaskFor(...texts: (string | null | undefined)[]): string | null {
  const parts = texts.filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const all = parts.join(" ");
  if (!ON_WATER.test(all) && !WATER_WORDS.test(all)) return null;
  for (const t of parts) for (const r of RULES) if (r.words.test(t)) return r.task;
  return null;
}

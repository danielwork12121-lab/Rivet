// Maps the task name the AI picked for a step onto the catalog's own task key, when the AI's
// name has no robots behind it. Plain code, no AI.
//
// Why this exists: robots are looked up by exact task string (robots.forTask). The AI is told to
// reuse a known task name when one fits, but for a job the catalog only recently started covering
// it invents its own ("aquatic weed removal" one run, "weed removal" the next), or picks a known
// one that only fits loosely ("inspection" for "survey the pond"). Either way the lookup came back
// empty and the step dead-ended. This only steps in when the AI's own name found nothing, and only
// for wording that clearly names one of these catalog tasks, so it never overrides a real hit.
// Water wording ("swamp", "marsh", "pond") goes to the aquatic tasks; the same weed wording on dry
// land ("cut tall weeds and brush", which the breakdown files under "trimming") goes to the
// catalog's brush-clearing robots, the remote slope/brush mowers that replace a string-trimmer crew.

export const WATER_SURVEY = "water survey";
export const AQUATIC_WEEDS = "aquatic weed removal";
export const DEBRIS_SKIMMING = "debris skimming";
export const BRUSH_CLEARING = "brush clearing";

// Words that put the work on or in a body of water.
const ON_WATER = /\b(ponds?|lakes?|lagoons?|wetlands?|marsh(es|y)?|swamps?|swampy|bogs?|fens?|reservoirs?|canals?|harbou?rs?|marinas?|rivers?|waterways?|aquatic|water(front|body)?|floating|shoreline|shore|dock|retention|detention|basin|estuar(y|ies))\b/;

// Survey first: "survey the pond for weeds" is a survey, not weed pulling.
const RULES: { task: string; words: RegExp }[] = [
  { task: WATER_SURVEY, words: /\b(survey(s|ing)?|inspect(ion|ing)?|mapping|bathymetr(y|ic)|sonar|monitor(ing)?|sampling|water quality)\b/ },
  { task: AQUATIC_WEEDS, words: /\b(weeds?|vegetation|plants?|hyacinth|duckweed|milfoil|hydrilla|lily|lilies|reeds?|algae|biomass|harvest(er|ing)?|muck|invasives?|phragmites|cattails?|overgrowth|amphibious)\b/ },
  { task: DEBRIS_SKIMMING, words: /\b(debris|trash|litter|garbage|waste|plastics?|skim(s|mer|ming)?|rubbish|flotsam)\b/ },
];

const WATER_WORDS = /\b(skim(mer|ming)?|aquatic|duckweed|hyacinth|milfoil|bathymetr(y|ic)|amphibious|phragmites|cattails?)\b/;

// Land work a string trimmer ("weed whacker") or brush cutter does today: tall weeds, brush,
// overgrowth. Spraying weeds is a different job (a sprayer, not a cutter), so it never maps here,
// and neither does neat edging around a fence, which no catalog robot does.
// "String trimmer" alone is left out on purpose: the breakdown uses it for trimming around fences.
const BRUSH_WORDS = /\b(brush|brushcutt(er|ing)|overgrown|overgrowth|undergrowth|scrub|tall grass|weeds?)\b/;
const NOT_BRUSH = /\b(spray(s|er|ing)?|herbicides?|chemicals?|pull(ing)?|edg(e|es|ing))\b/;

// The catalog task for this step, or null when no rule clearly applies. `texts` are, in order of
// trust, the AI's task name, then its search phrase (and/or the step's name). The water context may
// come from any of them; the task is decided by the first text that names one, so the AI's own
// task name wins over a loosely worded search phrase.
export function catalogTaskFor(...texts: (string | null | undefined)[]): string | null {
  const parts = texts.filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const all = parts.join(" ");
  if (!ON_WATER.test(all) && !WATER_WORDS.test(all)) {
    return BRUSH_WORDS.test(all) && !NOT_BRUSH.test(all) ? BRUSH_CLEARING : null;
  }
  for (const t of parts) for (const r of RULES) if (r.words.test(t)) return r.task;
  return null;
}

// The note a match carries when it went on without a web search. It is shown to the operator
// (step note, chat reply), so it must never name env vars, setup steps or the scraping vendor:
// those details go to the Convex logs instead (console.log), never into returned data.

// Live web discovery is deliberately off in production: matches come from the verified catalog
// (robots read by hand from vendor pages). Worded as what Rivet did, not as something broken.
export const SEARCH_OFF_NOTE = "Matched against Rivet's verified catalog: no listed robot covers this step yet.";
export const SEARCH_FAILED_NOTE = "Web search didn't work this time; results come from Rivet's catalog. Try again later.";

// Developer-facing text: env var names (APIFY_TOKEN), "set X" / "convex env" instructions,
// "on this backend", the vendor name or raw HTTP errors.
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bset [A-Z][A-Z0-9_]{2,}/; // case-sensitive: APIFY_TOKEN, not slope_mowing
const INTERNAL = /convex env|\bbackend\b|\bapify\b|\btoken\b|\bapi key\b|\b(GET|POST|PUT)\s+\/|\bfailed: [45]\d\d\b/i;

export const looksInternal = (text: string) => ENV_NAME.test(text) || INTERNAL.test(text);

// A search that failed: keep a plain reason ("the search took too long"), hide anything internal.
export function failedSearchNote(error: string | undefined): string {
  const reason = (error ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!reason || looksInternal(reason)) {
    if (reason) console.log(`web search failed (internal detail, not shown to users): ${reason}`);
    return SEARCH_FAILED_NOTE;
  }
  return `Web search failed: ${reason}`;
}

// Notes that mean "we didn't get to search", so an empty result isn't read as "no product".
// Covers today's wording and the older ones still stored on past matches.
export const isSearchSkippedNote = (note: string | null | undefined) =>
  !!note && (note === SEARCH_OFF_NOTE || /^Web search (is off|is turned off|skipped|failed|didn't work)/.test(note));

// What the page may show for a stored note: older rows were saved with the developer wording
// ("... (set DISCOVERY_ENABLED=true and APIFY_TOKEN)"), so it is cleaned on the way out too.
export function publicSearchNote(note: string | null | undefined): string | null {
  if (!note) return null;
  if (/^Web search (is turned off|is off)/.test(note)) return SEARCH_OFF_NOTE; // older wordings of the same state
  if (!looksInternal(note)) return note;
  return /^Web search (is turned off|is off)/.test(note) ? SEARCH_OFF_NOTE : SEARCH_FAILED_NOTE;
}

// Short titles and concept art for bounties posted from the Find a solution chat.
// pages/find-solution.html carries the same rule in plain JS between the
// "bounty-title-rule" markers; bountyTitle.test.ts checks the two agree.

// Cut at a word boundary, with an ellipsis, so a title never ends mid-word ("does i").
export function clipWords(text: string, max: number): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

// The job's first clause (up to the first , ; : . ! ? followed by a space), at most `max` characters.
export function shortJobTitle(text: string, max = 60): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const clause = t.split(/[,;:.!?](?:\s|$)/)[0].trim() || t;
  return clipWords(clause, max);
}

// Tidies a stored title for display: older posts saved "Robot for: <the whole job>" cut at 160.
export function tidyBountyTitle(title: string): string {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^Robot for: (.*)$/);
  return m ? "Robot for: " + shortJobTitle(m[1]) : clipWords(t, 100);
}

// Which concept sketch (img/bounties/<art>.jpg) fits the job; null means the drawn glyph tile.
const ART: [RegExp, string][] = [
  [/pond|weed|water|aquatic|algae|wetland|crop|garden|nursery/, "weeder"],
  [/debris|rock|rake|litter|grading|site prep/, "debris"],
  [/spill|leak|oil|absorb|hazmat/, "spill"],
  [/needle|syringe|sharps|biohazard/, "sharps"],
  [/flood|drain|culvert|storm|basement/, "flood"],
  [/stair|haul|carry|mulch|paver/, "stairs"],
  [/soil|sampl|probe|compaction/, "soil"],
  [/spray|fertil|pesticide/, "spray"],
];
export function bountyArt(text: string): string | null {
  const t = String(text || "").toLowerCase();
  for (const [re, art] of ART) if (re.test(t)) return art;
  return null;
}

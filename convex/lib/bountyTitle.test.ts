import { describe, expect, it } from "vitest";
import { dumpTemplate } from "../../scripts/edit-bundle.mjs";
import { bountyArt, clipWords, shortJobTitle, tidyBountyTitle } from "./bountyTitle";

const JOB = "Clear invasive weeds and floating debris from a 2-acre wetland pond at a residential community, from the water, without herbicide. A crew of 3 does it by hand twice a month, about $30,000 a year.";

describe("posted bounty titles", () => {
  it("uses the job's first clause, cut at a word boundary with an ellipsis", () => {
    const t = shortJobTitle(JOB);
    expect(t).toBe("Clear invasive weeds and floating debris from a 2-acre…");
    expect(t.length).toBeLessThanOrEqual(61);
    expect(shortJobTitle("Mow lawns on a weekly route. Crew of 2.")).toBe("Mow lawns on a weekly route");
    expect(shortJobTitle("Pick up 2.5 tons of rock")).toBe("Pick up 2.5 tons of rock"); // a decimal point is not a clause end
  });

  it("tidies a stored title that was cut mid-word at 160 characters", () => {
    const stored = ("Robot for: " + JOB).slice(0, 160);
    expect(stored.endsWith("does i")).toBe(true);
    expect(tidyBountyTitle(stored)).toBe("Robot for: Clear invasive weeds and floating debris from a 2-acre…");
    expect(tidyBountyTitle("Robot to skim floating debris off surface")).toBe("Robot to skim floating debris off surface");
    expect(clipWords("x".repeat(120), 100)).toHaveLength(101); // one long word: hard cut + ellipsis
  });

  it("picks the concept sketch from the task's words, else the drawn glyph", () => {
    expect(bountyArt(JOB)).toBe("weeder");
    expect(bountyArt("Robot to skim floating debris off surface")).toBe("debris");
    expect(bountyArt("Clean up an oil spill in the warehouse")).toBe("spill");
    expect(bountyArt("Wash the windows of a tower")).toBeNull();
  });
});

describe("find-solution.html uses the same rule", () => {
  const html = dumpTemplate("pages/find-solution.html") as string;
  const block = html.match(/\/\/ <bounty-title-rule>[\s\S]*?\/\/ <\/bounty-title-rule>/);
  it("has the rule block", () => expect(block).not.toBeNull());
  const page = new Function(`${block![0]}\nreturn { clipWords, shortJobTitle, tidyBountyTitle, bountyArt };`)();
  const cases = [JOB, ("Robot for: " + JOB).slice(0, 160), "Mow lawns on a weekly route. Crew of 2.", "x".repeat(120),
    "Robot to skim floating debris off surface", "Clean up an oil spill", "Wash the windows of a tower", ""];
  it.each(cases)("agrees on %#", (c) => {
    expect(page.shortJobTitle(c)).toBe(shortJobTitle(c));
    expect(page.tidyBountyTitle(c)).toBe(tidyBountyTitle(c));
    expect(page.clipWords(c, 100)).toBe(clipWords(c, 100));
    expect(page.bountyArt(c)).toBe(bountyArt(c));
  });

  it("no longer shows a grey 'Site photo' placeholder on bounty cards", () => {
    expect(html).not.toContain(">Site photo<");
    expect(html).not.toMatch(/'Robot for: ' \+ query\b/);
  });
});

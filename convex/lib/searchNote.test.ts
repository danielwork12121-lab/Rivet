import { describe, expect, it } from "vitest";
import { SEARCH_FAILED_NOTE, SEARCH_OFF_NOTE, failedSearchNote, isSearchSkippedNote, publicSearchNote } from "./searchNote";

const ENVISH = /[A-Z]+_[A-Z_]+|\bset [A-Z]|backend|apify|token/i;

describe("search notes shown to operators", () => {
  it("the off note is a plain sentence with no setup instructions", () => {
    expect(SEARCH_OFF_NOTE).not.toMatch(ENVISH);
    expect(SEARCH_FAILED_NOTE).not.toMatch(ENVISH);
    expect(isSearchSkippedNote(SEARCH_OFF_NOTE)).toBe(true);
    expect(isSearchSkippedNote(SEARCH_FAILED_NOTE)).toBe(true);
  });

  it("cleans the old developer wording still stored on past matches", () => {
    const old = "Web search is turned off on this backend (set DISCOVERY_ENABLED=true and APIFY_TOKEN).";
    expect(isSearchSkippedNote(old)).toBe(true);
    expect(publicSearchNote(old)).toBe(SEARCH_OFF_NOTE);
    expect(publicSearchNote("Web search failed: Apify POST /acts/x/runs failed: 400 invalid input")).toBe(SEARCH_FAILED_NOTE);
  });

  it("keeps plain, user-safe notes as they are", () => {
    const plain = 'The web search for "slope_mowing" robots read the pages it found but none described a robot.';
    expect(publicSearchNote(plain)).toBe(plain);
    expect(publicSearchNote("Web search skipped: The demo's web search budget for today has been used up.")).toMatch(/budget/);
    expect(publicSearchNote(null)).toBeNull();
  });

  it("keeps a plain failure reason but hides an internal one", () => {
    expect(failedSearchNote("the search took too long and was stopped.")).toBe("Web search failed: the search took too long and was stopped.");
    expect(failedSearchNote("Error: APIFY_TOKEN is not set in Convex")).toBe(SEARCH_FAILED_NOTE);
    expect(failedSearchNote("Apify run abc ended as ABORTED")).toBe(SEARCH_FAILED_NOTE);
    expect(failedSearchNote(undefined)).toBe(SEARCH_FAILED_NOTE);
  });
});

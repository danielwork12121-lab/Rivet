import { describe, expect, it } from "vitest";
import { AQUATIC_WEEDS, BRUSH_CLEARING, DEBRIS_SKIMMING, WATER_SURVEY, catalogTaskFor } from "./taskAlias";

describe("catalogTaskFor", () => {
  it("maps the task names the breakdown actually produced for the pond job", () => {
    // Taken from real production breakdowns of "survey the pond, pull invasive weeds, skim debris".
    expect(catalogTaskFor("inspection", "pond inspection drone")).toBe(WATER_SURVEY);
    expect(catalogTaskFor("aquatic weed removal", "robot aquatic weed harvester")).toBe(AQUATIC_WEEDS);
    expect(catalogTaskFor("weed removal", "aquatic weed removal robot")).toBe(AQUATIC_WEEDS);
    expect(catalogTaskFor("debris skimming", "autonomous pond surface skimmer")).toBe(DEBRIS_SKIMMING);
    expect(catalogTaskFor("debris removal", "floating debris skimmer robot")).toBe(DEBRIS_SKIMMING);
    expect(catalogTaskFor("debris hauling", "robot debris hauling pond")).toBe(DEBRIS_SKIMMING);
  });

  it("lets the AI's own task name win over a loosely worded phrase", () => {
    expect(catalogTaskFor("inspection", "pond weed survey robot")).toBe(WATER_SURVEY);
  });

  it("sends swamp and marsh wording to the aquatic tasks", () => {
    expect(catalogTaskFor("swamp clearing", "amphibious invasive vegetation harvester")).toBe(AQUATIC_WEEDS);
    expect(catalogTaskFor("reed cutting", "marsh phragmites cutter")).toBe(AQUATIC_WEEDS);
    expect(catalogTaskFor("vegetation removal", "bog cattail removal machine")).toBe(AQUATIC_WEEDS);
    expect(catalogTaskFor("debris removal", "swamp floating debris collector")).toBe(DEBRIS_SKIMMING);
  });

  it("sends dry-land weed and brush cutting (string-trimmer work) to brush clearing", () => {
    // Real production breakdowns of the founder's demo job (tall weeds, string trimmer, steep grass).
    expect(catalogTaskFor("trimming", "robot brush cutter for weeds")).toBe(BRUSH_CLEARING);
    expect(catalogTaskFor("brush cutting", "robot brush cutter rough terrain")).toBe(BRUSH_CLEARING);
    expect(catalogTaskFor("weed clearing", "weed whacker robot")).toBe(BRUSH_CLEARING);
    expect(catalogTaskFor("trimming", "remote string trimmer for tall grass")).toBe(BRUSH_CLEARING);
  });

  it("leaves land jobs alone, even ones with weeds or debris in them", () => {
    expect(catalogTaskFor("mowing", "steep slope mowing robot")).toBeNull();
    expect(catalogTaskFor("weed spraying", "lawn weed spraying robot")).toBeNull();
    expect(catalogTaskFor("trimming", "robot trimmer around fence")).toBeNull();
    expect(catalogTaskFor("trimming", "robotic string trimmer obstacle")).toBeNull();
    expect(catalogTaskFor("edging", "weed edging robot")).toBeNull();
    expect(catalogTaskFor("cleanup", "roadside debris cleanup robot")).toBeNull();
    expect(catalogTaskFor("mowing", "retention pond slope mower")).toBeNull();
    expect(catalogTaskFor("inspection", "pipe inspection crawler")).toBeNull();
    expect(catalogTaskFor(undefined, null)).toBeNull();
  });
});

// Test businesses for `npx convex run ai:runEvals`. `expect` is what a correct
// spec must contain. Add your own until you have about 12.
export type Persona = {
  name: string;
  request: {
    title: string;
    description: string;
    environment: string;
    constraints: string[];
    currentAnnualCost?: number;
  };
  expect: {
    taskIncludes: string; // a word that must appear in the spec's tasks
    mustAskAbout?: string; // a word that must appear in a follow-up question
  };
};

export const PERSONAS: Persona[] = [
  {
    name: "Culvert inspection, full info",
    request: {
      title: "Inspect culvert interiors",
      description: "We inspect 60 culverts under county roads every year. Two techs crawl in with flashlights, about 4 hours each.",
      environment: "Confined, wet, no GPS, 0.8 m diameter",
      constraints: ["Must be tethered", "Under 5 kg"],
      currentAnnualCost: 40000,
    },
    expect: { taskIncludes: "inspect" },
  },
  {
    name: "Lawn care, missing cost",
    request: {
      title: "Mow commercial lawns",
      description: "3 crews mow office park lawns all week.",
      environment: "Outdoor, flat grass, some slopes",
      constraints: [],
    },
    expect: { taskIncludes: "mow", mustAskAbout: "cost" },
  },
  {
    name: "Pest control spraying",
    request: {
      title: "Spray perimeter treatments",
      description: "2 techs spray 40 homes a week, about 1.5 hours per home, mostly the outside walls and yard edges.",
      environment: "Residential yards, fences, uneven ground",
      constraints: ["Must not spray people or pets"],
      currentAnnualCost: 95000,
    },
    expect: { taskIncludes: "spray" },
  },
  {
    name: "Vague request",
    request: {
      title: "Help with yards",
      description: "We do yards.",
      environment: "Outside",
      constraints: [],
    },
    expect: { taskIncludes: "", mustAskAbout: "" }, // must ask at least one question
  },
];
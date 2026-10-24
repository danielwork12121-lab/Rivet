import { ConvexError } from "convex/values";

// Pure input checks that Convex's type validators can't express. No database
// access, so they are trivially unit-testable. Failures throw ConvexError, whose
// message reaches the browser on production deployments (plain Errors are
// redacted there): clients read it from `err.data`.

export const LIMITS = {
  title: 120,
  description: 5000,
  environment: 2000,
  constraintCount: 20,
  constraint: 500,
  costNotes: 1000,
  maxMoney: 1_000_000_000_000,
  companyName: 100,
  profileText: 50,
  headcount: 10_000,
  maxHourlyCost: 10_000,
  followUpCount: 10,
  question: 500,
  answerLabel: 200,
  unit: 30,
} as const;

const CLIENT_TOKEN = /^[A-Za-z0-9_-]{8,100}$/;
const ANSWER_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;

export type CostInfo = {
  currency: string;
  currentAnnualCost?: number;
  budget?: number;
  notes?: string;
};

export type ProfileInfo = {
  companyName: string;
  businessType: string;
  region: string;
  crewCount: number;
  peoplePerCrew?: number;
  hourlyLaborCost: number;
  visibility: "shared" | "anonymous";
};

export type RequestInput = {
  title: string;
  description: string;
  environment: string;
  constraints: string[];
  cost?: CostInfo;
  profile?: ProfileInfo;
  clientToken?: string;
};

function requireText(label: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ConvexError(`${label} must not be empty`);
  if (trimmed.length > max) {
    throw new ConvexError(`${label} must be at most ${max} characters`);
  }
  return trimmed;
}

function checkMoney(label: string, value: number | undefined) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > LIMITS.maxMoney) {
    throw new ConvexError(`${label} must be a non-negative number`);
  }
}

function requireCount(label: string, value: number) {
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.headcount) {
    throw new ConvexError(`${label} must be a whole number from 1 to ${LIMITS.headcount}`);
  }
}

function validateProfile(p: ProfileInfo): ProfileInfo {
  requireCount("profile.crewCount", p.crewCount);
  if (p.peoplePerCrew !== undefined) requireCount("profile.peoplePerCrew", p.peoplePerCrew);
  if (
    !Number.isFinite(p.hourlyLaborCost) ||
    p.hourlyLaborCost <= 0 ||
    p.hourlyLaborCost > LIMITS.maxHourlyCost
  ) {
    throw new ConvexError(
      `profile.hourlyLaborCost must be greater than 0 and at most ${LIMITS.maxHourlyCost}`,
    );
  }
  return {
    companyName: requireText("profile.companyName", p.companyName, LIMITS.companyName),
    businessType: requireText("profile.businessType", p.businessType, LIMITS.profileText),
    region: requireText("profile.region", p.region, LIMITS.profileText),
    crewCount: p.crewCount,
    ...(p.peoplePerCrew !== undefined && { peoplePerCrew: p.peoplePerCrew }),
    hourlyLaborCost: p.hourlyLaborCost,
    visibility: p.visibility,
  };
}

/** Returns a trimmed, validated copy of the input or throws an Error. */
export function validateRequestInput(input: RequestInput): RequestInput {
  const constraints = input.constraints
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (constraints.length > LIMITS.constraintCount) {
    throw new ConvexError(`At most ${LIMITS.constraintCount} constraints allowed`);
  }
  for (const c of constraints) {
    if (c.length > LIMITS.constraint) {
      throw new ConvexError(`Each constraint must be at most ${LIMITS.constraint} characters`);
    }
  }

  let cost: CostInfo | undefined;
  if (input.cost) {
    const currency = input.cost.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ConvexError("cost.currency must be a 3-letter code such as USD");
    }
    checkMoney("cost.currentAnnualCost", input.cost.currentAnnualCost);
    checkMoney("cost.budget", input.cost.budget);
    const notes = input.cost.notes?.trim();
    if (notes && notes.length > LIMITS.costNotes) {
      throw new ConvexError(`cost.notes must be at most ${LIMITS.costNotes} characters`);
    }
    cost = {
      currency,
      ...(input.cost.currentAnnualCost !== undefined && {
        currentAnnualCost: input.cost.currentAnnualCost,
      }),
      ...(input.cost.budget !== undefined && { budget: input.cost.budget }),
      ...(notes ? { notes } : {}),
    };
  }

  if (input.clientToken !== undefined && !CLIENT_TOKEN.test(input.clientToken)) {
    throw new ConvexError(
      "clientToken must be 8-100 characters: letters, digits, '-' or '_'",
    );
  }

  return {
    title: requireText("title", input.title, LIMITS.title),
    description: requireText("description", input.description, LIMITS.description),
    environment: requireText("environment", input.environment, LIMITS.environment),
    constraints,
    ...(cost ? { cost } : {}),
    ...(input.profile ? { profile: validateProfile(input.profile) } : {}),
    ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
  };
}

export type FollowUpAnswer = {
  key: string;
  question: string;
  answerLabel: string;
  assumption?: { value: number; unit?: string };
};

/** Validates a full set of follow-up answers; returns a trimmed copy or throws. */
export function validateFollowUps(answers: FollowUpAnswer[]): FollowUpAnswer[] {
  if (answers.length > LIMITS.followUpCount) {
    throw new ConvexError(`At most ${LIMITS.followUpCount} follow-up answers allowed`);
  }
  const seen = new Set<string>();
  return answers.map((a) => {
    if (!ANSWER_KEY.test(a.key)) {
      throw new ConvexError(
        "followUps.key must start with a letter and use only letters, digits, '-' or '_' (max 50)",
      );
    }
    if (seen.has(a.key)) throw new ConvexError(`followUps has a duplicate key: ${a.key}`);
    seen.add(a.key);
    const out: FollowUpAnswer = {
      key: a.key,
      question: requireText("followUps.question", a.question, LIMITS.question),
      answerLabel: requireText("followUps.answerLabel", a.answerLabel, LIMITS.answerLabel),
    };
    if (a.assumption) {
      if (!Number.isFinite(a.assumption.value)) {
        throw new ConvexError("followUps.assumption.value must be a finite number");
      }
      const unit =
        a.assumption.unit === undefined
          ? undefined
          : requireText("followUps.assumption.unit", a.assumption.unit, LIMITS.unit);
      out.assumption = { value: a.assumption.value, ...(unit ? { unit } : {}) };
    }
    return out;
  });
}

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
} as const;

export type CostInfo = {
  currency: string;
  currentAnnualCost?: number;
  budget?: number;
  notes?: string;
};

export type RequestInput = {
  title: string;
  description: string;
  environment: string;
  constraints: string[];
  cost?: CostInfo;
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

  return {
    title: requireText("title", input.title, LIMITS.title),
    description: requireText("description", input.description, LIMITS.description),
    environment: requireText("environment", input.environment, LIMITS.environment),
    constraints,
    ...(cost ? { cost } : {}),
  };
}

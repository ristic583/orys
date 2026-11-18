import { EFFORTS, MODELS, type Effort, type Model } from "./types.js";

export type RoleSetting = { model: Model; effort: Effort };

export type Profile = {
  /** Studies an existing repository before anything is planned. */
  mapper: RoleSetting;
  architect: RoleSetting;
  planner: RoleSetting;
  /** Used when the planner gives no suggestion for a task. */
  workerDefault: RoleSetting;
  /** Worker models the planner may pick from; anything else is clamped into this range. */
  workerModels: readonly Model[];
  /** Highest effort a worker may run with. */
  workerMaxEffort: Effort;
  masterReview: RoleSetting;
  /** Master reviews every task (true) or only whole phases (false). */
  reviewPerTask: boolean;
  maxAttempts: number;
};

export const PROFILES = {
  quality: {
    mapper: { model: "opus", effort: "high" },
    architect: { model: "opus", effort: "high" },
    planner: { model: "opus", effort: "high" },
    workerDefault: { model: "sonnet", effort: "high" },
    workerModels: ["sonnet", "opus"],
    workerMaxEffort: "high",
    masterReview: { model: "opus", effort: "medium" },
    reviewPerTask: true,
    maxAttempts: 4,
  },
  balanced: {
    mapper: { model: "sonnet", effort: "high" },
    architect: { model: "opus", effort: "high" },
    planner: { model: "opus", effort: "medium" },
    workerDefault: { model: "sonnet", effort: "medium" },
    workerModels: ["haiku", "sonnet", "opus"],
    workerMaxEffort: "high",
    masterReview: { model: "sonnet", effort: "high" },
    reviewPerTask: true,
    maxAttempts: 3,
  },
  speed: {
    mapper: { model: "sonnet", effort: "medium" },
    architect: { model: "opus", effort: "medium" },
    planner: { model: "sonnet", effort: "medium" },
    workerDefault: { model: "sonnet", effort: "low" },
    workerModels: ["haiku", "sonnet"],
    workerMaxEffort: "medium",
    masterReview: { model: "sonnet", effort: "medium" },
    reviewPerTask: false,
    maxAttempts: 2,
  },
  cost: {
    mapper: { model: "sonnet", effort: "medium" },
    architect: { model: "sonnet", effort: "high" },
    planner: { model: "sonnet", effort: "medium" },
    workerDefault: { model: "sonnet", effort: "low" },
    workerModels: ["haiku", "sonnet"],
    workerMaxEffort: "medium",
    masterReview: { model: "sonnet", effort: "low" },
    reviewPerTask: false,
    maxAttempts: 2,
  },
} as const satisfies Record<string, Profile>;

export type ProfileName = keyof typeof PROFILES;

const rank = <T>(list: readonly T[], v: T) => list.indexOf(v);

/** Clamp a value into the allowed subset, keeping order (haiku < sonnet < opus). */
function clampModel(model: Model, allowed: readonly Model[]): Model {
  if (allowed.includes(model)) return model;
  const sorted = [...allowed].sort((a, b) => rank(MODELS, a) - rank(MODELS, b));
  const lowest = sorted[0]!;
  const highest = sorted[sorted.length - 1]!;
  return rank(MODELS, model) < rank(MODELS, lowest) ? lowest : highest;
}

/** Pick the worker model/effort for a task: planner suggestion, clamped by the project's profile. */
export function resolveWorker(profile: Profile, suggested?: Partial<RoleSetting>): RoleSetting {
  const model = clampModel(suggested?.model ?? profile.workerDefault.model, profile.workerModels);
  const wanted = suggested?.effort ?? profile.workerDefault.effort;
  const effort = rank(EFFORTS, wanted) > rank(EFFORTS, profile.workerMaxEffort) ? profile.workerMaxEffort : wanted;
  return { model, effort };
}

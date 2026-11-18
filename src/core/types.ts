export const MODELS = ["haiku", "sonnet", "opus"] as const;
export type Model = (typeof MODELS)[number];

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PROJECT_STATUSES = ["draft", "sketching", "mapping", "architecting", "awaiting_owner", "planning", "executing", "blocked", "done"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** How a project enters Orys (SPEC §17). */
export const PROJECT_MODES = ["scratch", "existing", "rework"] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];

/** Decisions the owner must make before the project continues (status `awaiting_owner`). */
export const OWNER_GATES = ["pick_proposals", "confirm_goal", "approve_sketch", "approve_plan"] as const;
export type OwnerGate = (typeof OWNER_GATES)[number];

export const REWORK_KINDS = ["redesign_ui", "refactor", "tests", "performance", "security", "dependencies"] as const;
export type ReworkKind = (typeof REWORK_KINDS)[number];

export const PHASE_STATUSES = ["pending", "active", "reviewing", "blocked", "done"] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const TASK_STATUSES = [
  "pending", // waiting for dependencies
  "ready", // can be picked up
  "running", // worker session in progress
  "verifying", // master code runs verify_commands
  "reviewing", // master Claude review
  "rework", // failed verification/review, will be retried with feedback
  "interrupted", // stopped by limit/auth/restart, resumes without using an attempt
  "escalated", // master asked for the user; waits for an answer
  "failed", // ran out of attempts
  "skipped", // user skipped it; counts as satisfied for dependencies
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Task statuses the scheduler may start a worker from. */
export const STARTABLE_TASK_STATUSES: readonly TaskStatus[] = ["ready", "rework", "interrupted"];
/** Task statuses that satisfy a dependency. */
export const SATISFIED_TASK_STATUSES: readonly TaskStatus[] = ["done", "skipped"];

export const RUN_KINDS = ["mapper", "architect", "planner", "worker", "master_review", "probe", "designer", "handoff", "sketch"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const ERROR_KINDS = ["limit", "auth", "crash", "timeout", "parse"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const DECISIONS = ["approve", "rework", "escalate"] as const;
export type Decision = (typeof DECISIONS)[number];

export const LIMIT_STATUSES = ["ok", "warning", "limited"] as const;
export type LimitStatus = (typeof LIMIT_STATUSES)[number];

export const RUNNERS = ["local"] as const;
export type RunnerKind = (typeof RUNNERS)[number];

/** Wizard answers for a project already in progress. */
export type ExistingDetails = {
  /** What the project does and how far it got. (The brief's `problem` holds the overall purpose.) */
  currentState: string;
  /** What should happen next, or what hurts. */
  nextGoals: string;
  /** Paths or areas the agents must not change. */
  offLimits: string[];
  /** Known build/test commands; empty = let the mapper find them. */
  verifyCommands: string[];
};

/** Wizard answers for a redesign / refactor / testing pass. */
export type ReworkDetails = {
  kinds: ReworkKind[];
  /** Measurable targets, e.g. "coverage ≥ 80%". */
  successCriteria: string[];
  /** Public behavior and APIs must stay the same. */
  behaviorFrozen: boolean;
  /** Paths in scope; empty = whole repo. */
  scope: string[];
};

export type ModeDetails = { existing?: ExistingDetails; rework?: ReworkDetails };

/** Per-task review override (SPEC §17.3): follow the profile, or force on/off. */
export const TASK_REVIEW_MODES = ["default", "always", "never"] as const;
export type TaskReviewMode = (typeof TASK_REVIEW_MODES)[number];

/** Who chose a task's model: the planner (clamped into the profile) or the owner (used as-is). */
export const MODEL_SOURCES = ["planner", "owner"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export const AGENT_ROLES = ["mapper", "architect", "planner", "worker", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type RoleModels = Partial<Record<AgentRole, { model: Model; effort: Effort }>>;

/** Where agents work on an existing repo: in place on ai-pm/* branches, or on a disposable copy (test mode). */
export const WORKSPACES = ["in_place", "sandbox"] as const;
export type WorkspaceMode = (typeof WORKSPACES)[number];

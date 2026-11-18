import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { newId } from "../core/ids.js";
import {
  DECISIONS,
  EFFORTS,
  ERROR_KINDS,
  LIMIT_STATUSES,
  MODELS,
  OWNER_GATES,
  PHASE_STATUSES,
  PROJECT_MODES,
  PROJECT_STATUSES,
  RUN_KINDS,
  RUNNERS,
  TASK_STATUSES,
  TASK_REVIEW_MODES,
  MODEL_SOURCES,
  WORKSPACES,
  type ModeDetails,
  type RoleModels,
} from "../core/types.js";
import { PROFILES, type ProfileName } from "../core/profiles.js";
import { SIZES, type DesignChoice, type Handoff, type ProcessChoice, type SketchOutput, type StoredOutcome } from "../core/outcome.js";

const PROFILE_NAMES = Object.keys(PROFILES) as [ProfileName, ...ProfileName[]];

const id = () => text("id").primaryKey().$defaultFn(() => newId());
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};
const jsonStrings = (name: string) =>
  text(name, { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`);

export const projects = sqliteTable("projects", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  problem: text("problem").notNull(),
  aspects: jsonStrings("aspects"),
  constraints: jsonStrings("constraints"),
  priority: integer("priority").notNull().default(3),
  profile: text("profile", { enum: PROFILE_NAMES }).notNull().default("balanced"),
  deadline: integer("deadline", { mode: "timestamp_ms" }),
  runner: text("runner", { enum: RUNNERS }).notNull().default("local"),
  repoPath: text("repo_path").notNull(),
  mode: text("mode", { enum: PROJECT_MODES }).notNull().default("scratch"),
  /** Mode-specific wizard answers (SPEC §17.1): { existing?: …, rework?: … }. */
  modeDetails: text("mode_details", { mode: "json" }).$type<ModeDetails>().notNull().default(sql`'{}'`),
  /** The owner's branch in an existing repo; only changed on an explicit merge. Null for scratch projects. */
  baseBranch: text("base_branch"),
  /** Where approved phases are merged: "main" for scratch projects, "ai-pm/main" in an existing repo. */
  integrationBranch: text("integration_branch").notNull().default("main"),
  /** sandbox = agents work on a copy in AIPM_SANDBOX_DIR; the original at `sourcePath` is never touched. */
  workspace: text("workspace", { enum: WORKSPACES }).notNull().default("in_place"),
  /** The owner's original folder when `workspace` is sandbox. */
  sourcePath: text("source_path"),
  /** Permission mode for worker sessions (SPEC §6.2). */
  workerPermissionMode: text("worker_permission_mode").notNull().default("bypassPermissions"),
  status: text("status", { enum: PROJECT_STATUSES }).notNull().default("draft"),
  blockedFrom: text("blocked_from", { enum: PROJECT_STATUSES }),
  blockedReason: text("blocked_reason"),
  /** Set while status is awaiting_owner: which decision is pending. */
  ownerGate: text("owner_gate", { enum: OWNER_GATES }),
  /** Owner's model choice per agent role; missing roles use the profile (SPEC §17.3). */
  roleModels: text("role_models", { mode: "json" }).$type<RoleModels>().notNull().default(sql`'{}'`),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  /** What the approved plan promises the owner (SPEC §19, LEVEL2 step 1), plus the owner's answers to its open questions. */
  outcome: text("outcome_json", { mode: "json" }).$type<StoredOutcome>(),
  /** How much process this work gets, chosen from the planner's scope assessment (quick / standard / full). */
  process: text("process_json", { mode: "json" }).$type<ProcessChoice>(),
  /** Design direction the owner picked before building (UI work). */
  designChoice: text("design_choice", { mode: "json" }).$type<DesignChoice>(),
  /** What was delivered, written at the end for the owner (summary, promises kept, how to see it). */
  handoff: text("handoff_json", { mode: "json" }).$type<Handoff>(),
  /** The owner's verdict on the handoff: null = not yet, true = accepted, false = sent back. */
  accepted: integer("accepted", { mode: "boolean" }),
  /** Times the owner sent the result back; "accepted without changes" = accepted with 0 returns. */
  returns: integer("returns").notNull().default(0),
  /** Sketch-first flow (SPEC §22.7): show something within minutes, agree on it, then build. */
  sketch: integer("sketch", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const features = sqliteTable(
  "features",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: integer("priority").notNull().default(3),
    deadline: integer("deadline", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["planned", "in_progress", "done"] }).notNull().default("planned"),
    ...timestamps,
  },
  (t) => [index("features_project_idx").on(t.projectId)],
);

export const phases = sqliteTable(
  "phases",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status", { enum: PHASE_STATUSES }).notNull().default("pending"),
    branch: text("branch").notNull(),
    /** "After this phase you can …", for the owner. */
    goalPlain: text("goal_plain"),
    /** Whether the owner can see something new after this phase. */
    visible: integer("visible", { mode: "boolean" }).notNull().default(false),
    /** Extra gate run once on the phase branch tip before the phase review (slow/full checks). */
    verifyCommands: jsonStrings("verify_commands"),
    ...timestamps,
  },
  (t) => [uniqueIndex("phases_project_idx").on(t.projectId, t.idx)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    phaseId: text("phase_id").notNull().references(() => phases.id, { onDelete: "cascade" }),
    featureId: text("feature_id").references(() => features.id, { onDelete: "set null" }),
    idx: integer("idx").notNull(),
    /** Planner's local key, e.g. "p1-db"; used in commit messages. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    spec: text("spec").notNull(),
    acceptance: jsonStrings("acceptance"),
    verifyCommands: jsonStrings("verify_commands"),
    /** Task ids. */
    dependsOn: jsonStrings("depends_on"),
    model: text("model", { enum: MODELS }),
    effort: text("effort", { enum: EFFORTS }),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    sessionId: text("session_id"),
    lastFeedback: text("last_feedback"),
    /** Commit the task started from; the task's diff for review is baseSha..HEAD. */
    baseSha: text("base_sha"),
    review: text("review", { enum: TASK_REVIEW_MODES }).notNull().default("default"),
    modelSource: text("model_source", { enum: MODEL_SOURCES }).notNull().default("planner"),
    /** XS–XL, the planner's estimate of the agent work; input for the estimate (§21). */
    size: text("size", { enum: SIZES }),
    ...timestamps,
  },
  (t) => [index("tasks_phase_idx").on(t.phaseId, t.idx), index("tasks_status_idx").on(t.status)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    sessionId: text("session_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    exitCode: integer("exit_code"),
    isError: integer("is_error", { mode: "boolean" }),
    errorKind: text("error_kind", { enum: ERROR_KINDS }),
    resultText: text("result_text"),
    costUsd: real("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    numTurns: integer("num_turns").notNull().default(0),
    /** Context size at the end of the run (input + cache read + cache write of the last call). */
    contextTokens: integer("context_tokens").notNull().default(0),
    logPath: text("log_path"),
  },
  (t) => [index("runs_project_started_idx").on(t.projectId, t.startedAt), index("runs_task_idx").on(t.taskId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: id(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    command: text("command").notNull(),
    exitCode: integer("exit_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    outputTail: text("output_tail").notNull().default(""),
    /** Re-run on the commit before the task (or phase), to tell pre-existing failures from new ones. */
    baseline: integer("baseline", { mode: "boolean" }).notNull().default(false),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("verifications_task_idx").on(t.taskId)],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** What was reviewed. */
    target: text("target", { enum: ["architecture", "plan", "task", "phase"] }).notNull(),
    kind: text("kind", { enum: DECISIONS }).notNull(),
    rationale: text("rationale").notNull(),
    feedback: text("feedback").notNull().default(""),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("decisions_project_idx").on(t.projectId)],
);

/** Single row (id = "global"): subscription limit state from rate_limit_event (SPEC §6.3). */
export const limitState = sqliteTable("limit_state", {
  id: text("id").primaryKey().default("global"),
  status: text("status", { enum: LIMIT_STATUSES }).notNull().default("ok"),
  rateLimitType: text("rate_limit_type"),
  utilization: real("utilization"),
  resetAt: integer("reset_at", { mode: "timestamp_ms" }),
  detectedAt: integer("detected_at", { mode: "timestamp_ms" }),
  sourceText: text("source_text"),
  lastProbeAt: integer("last_probe_at", { mode: "timestamp_ms" }),
  /** Set when the CLI is not logged in; scheduler pauses globally. */
  authError: text("auth_error"),
  updatedAt: timestamps.updatedAt,
});

/**
 * Session slots (SPEC §17.7): a limited set of long-lived Claude sessions, one
 * per project. A project claims a free slot when it is created; its builder
 * agents (mapper/architect, planner, workers) continue the same session, so the
 * project's context carries over from task to task. `--resume` forks a new id
 * each run, so `sessionId` always holds the latest link of the chain.
 */
export const sessionSlots = sqliteTable(
  "session_slots",
  {
    id: id(),
    idx: integer("idx").notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    contextTokens: integer("context_tokens").notNull().default(0),
    runs: integer("runs").notNull().default(0),
    /** Times the session was replaced by a fresh one (too large, or reset by the owner). */
    rotations: integer("rotations").notNull().default(0),
    assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("session_slots_idx").on(t.idx), uniqueIndex("session_slots_project").on(t.projectId)],
);

/**
 * Sketch versions (SPEC §22.7): a quick, visible draft the owner reacts to
 * before anything is planned. `ready` waits for the owner; `revise` carries
 * the owner's note for the next version; one version ends `approved`.
 */
export const sketches = sqliteTable(
  "sketches",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", { enum: ["ready", "revise", "approved", "skipped"] }).notNull().default("ready"),
    summary: text("summary_json", { mode: "json" }).$type<SketchOutput>().notNull(),
    /** The owner's reaction that asked for the next version. */
    feedback: text("feedback"),
    /** Direction the owner picked when the sketch offered several. */
    direction: text("direction"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("sketches_project_version").on(t.projectId, t.version)],
);
export type Sketch = typeof sketches.$inferSelect;

export const events = sqliteTable(
  "events",
  {
    id: id(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("events_project_created_idx").on(t.projectId, t.createdAt)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Feature = typeof features.$inferSelect;
export type Phase = typeof phases.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type LimitStateRow = typeof limitState.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type SessionSlot = typeof sessionSlots.$inferSelect;

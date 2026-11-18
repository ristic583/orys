import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { ClaudeOutcome } from "../claude/client.js";
import type { Config } from "../config.js";
import { PROFILES, resolveWorker, type Profile, type RoleSetting } from "../core/profiles.js";
import { withProcess } from "../core/outcome.js";
import { AGENT_ROLES, type AgentRole, type Effort, type Model } from "../core/types.js";
import type { RunKind } from "../core/types.js";
import type { DbOrTx } from "../db/index.js";
import { decisions, runs, type DecisionRow, type Project, type Run } from "../db/schema.js";
import { recordClaudeRun, type RecorderDeps, type RunContext } from "../runs/recorder.js";
import type { Workspace } from "../runner/types.js";
import { afterBuilderRun, claimSlot } from "../sessions/slots.js";

export type LoopDeps = RecorderDeps & { config: Config };

export type StepResult =
  | { status: "progressed"; message: string }
  | { status: "interrupted"; message: string }
  | { status: "blocked"; message: string }
  | { status: "failed"; message: string }
  | { status: "idle"; message: string };

export type ReviewTarget = DecisionRow["target"];

/** The project's profile, with its process (quick/standard/full, chosen from the plan's scope) applied. */
export const profileOf = (p: Project): Profile => withProcess(PROFILES[p.profile], p.process);

/** Model and effort for an agent role: the owner's override, else the profile (SPEC §17.3). */
export function roleOf(p: Project, role: AgentRole): RoleSetting {
  const profile = profileOf(p);
  const fromProfile: Record<AgentRole, RoleSetting> = {
    mapper: profile.mapper,
    architect: profile.architect,
    planner: profile.planner,
    worker: profile.workerDefault,
    reviewer: profile.masterReview,
  };
  return p.roleModels?.[role] ?? fromProfile[role];
}

export function effectiveRoles(p: Project): Record<AgentRole, RoleSetting & { source: "project" | "profile" }> {
  return Object.fromEntries(
    AGENT_ROLES.map((r) => [r, { ...roleOf(p, r), source: p.roleModels?.[r] ? "project" : "profile" }]),
  ) as Record<AgentRole, RoleSetting & { source: "project" | "profile" }>;
}

/**
 * The model a worker runs with: the owner's choice on the task wins, then the
 * owner's worker default, then the planner's suggestion clamped to the profile.
 */
export function workerFor(p: Project, task: { model: Model | null; effort: Effort | null; modelSource: "planner" | "owner" }): RoleSetting {
  if (task.modelSource === "owner" && task.model) return { model: task.model, effort: task.effort ?? roleOf(p, "worker").effort };
  if (p.roleModels?.worker) return p.roleModels.worker;
  return resolveWorker(profileOf(p), { model: task.model ?? undefined, effort: task.effort ?? undefined });
}
export const ws = (p: Project) => ({ slug: p.slug, repoPath: p.repoPath });

/** Limit, auth and our own shutdown stop work without counting as a failure. */
export function isInterrupt(o: ClaudeOutcome): boolean {
  return o.aborted || o.errorKind === "limit" || o.errorKind === "auth";
}

export const READ_ONLY_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"];

type Scope = { projectId: string; target: ReviewTarget; phaseId?: string | null; taskId?: string | null };

const scopeWhere = (s: Scope) =>
  and(
    eq(decisions.projectId, s.projectId),
    eq(decisions.target, s.target),
    s.phaseId ? eq(decisions.phaseId, s.phaseId) : isNull(decisions.phaseId),
    s.taskId ? eq(decisions.taskId, s.taskId) : isNull(decisions.taskId),
  );

export function decisionsFor(db: DbOrTx, s: Scope): DecisionRow[] {
  return db.select().from(decisions).where(scopeWhere(s)).orderBy(desc(decisions.id)).all();
}

/** User answers are stored as decisions without a run; they reset the attempt budget. */
export function lastUserAnswer(list: DecisionRow[]): DecisionRow | undefined {
  return list.find((d) => d.runId === null);
}

export function lastRun(db: DbOrTx, projectId: string, kind: RunKind): Run | undefined {
  return db.select().from(runs).where(and(eq(runs.projectId, projectId), eq(runs.kind, kind), isNotNull(runs.endedAt))).orderBy(desc(runs.id)).get();
}

/**
 * Attempts used at a planning stage since the last user answer: reviewer
 * reworks plus author runs that crashed, timed out or produced unusable output.
 */
export function attemptsUsed(db: DbOrTx, projectId: string, target: ReviewTarget, authorKind: RunKind): number {
  const list = decisionsFor(db, { projectId, target });
  const since = lastUserAnswer(list)?.id ?? "";
  const reworks = list.filter((d) => d.runId !== null && d.kind === "rework" && d.id > since).length;
  const failures = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, authorKind), inArray(runs.errorKind, ["crash", "timeout", "parse"]), gt(runs.id, since)))
    .all().length;
  return reworks + failures;
}

export function markRunParseError(db: DbOrTx, runId: string, error: string): void {
  db.update(runs).set({ errorKind: "parse", isError: true, resultText: `[unusable output] ${error}`.slice(0, 4_000) }).where(eq(runs.id, runId)).run();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n… (truncated, ${s.length - max} more characters)` : s;
}

export type LoopConfig = Pick<Config, "timeouts">;

/** Test mode (workspace sandbox): agents may not run git at all; Orys commits for them in the copy. */
export const NO_GIT = ["Bash(git:*)"];
export const isSandbox = (p: Pick<Project, "workspace">) => p.workspace === "sandbox";

/**
 * Run a builder agent (mapper, architect, planner, worker). The run continues
 * the project's session (its latest link; created on first use), and the
 * session is updated afterwards (SPEC §17.7). Reviews do not use this.
 */
export async function builderRun(deps: LoopDeps, project: Project, w: Workspace, ctx: RunContext, req: Parameters<typeof recordClaudeRun>[3]) {
  const slot = claimSlot(deps.db, project);
  // The project session is the only session builders continue (fresh when it was just rotated).
  const resume = slot.sessionId ?? undefined;
  const r = await recordClaudeRun(deps, w, ctx, { ...req, resumeSessionId: resume });
  afterBuilderRun(deps.db, project.id, r.outcome, !!slot.sessionId, deps.config.AIPM_SESSION_MAX_CONTEXT);
  return r;
}

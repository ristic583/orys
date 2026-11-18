/**
 * The owner's plan editor (SPEC §17.3): change phases and tasks of a stored
 * plan, validated as a whole after every edit, plus the approve-plan gate.
 * Every operation runs in one transaction; an invalid result is rolled back
 * and reported as structured problems the UI can point at.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tasksToRelease } from "../core/stateMachines.js";
import { EFFORTS, MODELS, TASK_REVIEW_MODES, type TaskStatus } from "../core/types.js";
import type { Db, DbOrTx } from "../db/index.js";
import { phases, tasks, type Phase, type Project, type Task } from "../db/schema.js";
import { profileOf } from "../loops/common.js";
import { assertReadyToApprove } from "./outcome.js";
import { FORBIDDEN_COMMAND, findCycle, slugify, type Plan } from "../loops/plan.js";
import { recordUserAnswer } from "../loops/review.js";
import { applyProjectEvent, getProject, logEvent, phaseBranch } from "./repo.js";

// ─────────── errors ───────────

export type PlanProblem = { message: string; taskKey?: string; phaseIdx?: number; field?: string };

export class PlanInvalid extends Error {
  constructor(public readonly problems: PlanProblem[]) {
    super(`the plan would be invalid: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "PlanInvalid";
  }
}

export class EditRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditRefused";
  }
}

// ─────────── what may be edited ───────────

const EDITABLE_TASK: TaskStatus[] = ["pending", "ready", "failed", "escalated"];
const PROJECT_EDITABLE = (p: Project) =>
  (p.status === "awaiting_owner" && p.ownerGate === "approve_plan") || p.status === "executing" || (p.status === "blocked" && p.blockedFrom === "executing");

export type LockedReason = "running" | "in_review" | "done" | "skipped" | "phase_started" | "phase_done" | "in_progress";

/** Why a task cannot be edited, or null when it can. */
export function taskLock(t: Pick<Task, "status">): LockedReason | null {
  if (EDITABLE_TASK.includes(t.status)) return null;
  if (t.status === "running") return "running";
  if (t.status === "verifying" || t.status === "reviewing") return "in_review";
  if (t.status === "done") return "done";
  if (t.status === "skipped") return "skipped";
  return "in_progress"; // rework / interrupted: a session is mid-way
}

/** Phases that have not started can be changed freely; an active phase only gets new tasks and text edits. */
export function phaseLock(ph: Pick<Phase, "status">, op: "edit" | "delete" | "add_task"): LockedReason | null {
  if (ph.status === "done") return "phase_done";
  if (op === "delete" && ph.status !== "pending") return "phase_started";
  if (op === "add_task" && ph.status !== "pending" && ph.status !== "active") return "phase_started";
  return null;
}

// ─────────── inputs ───────────

const lines = z.array(z.string().trim().min(1));
const TaskFields = {
  title: z.string().trim().min(1),
  spec: z.string().trim().min(1),
  acceptance: lines.min(1),
  verifyCommands: lines.min(1),
  dependsOn: z.array(z.string()),
  /** null = let the planner/profile decide again. */
  model: z.enum(MODELS).nullable(),
  effort: z.enum(EFFORTS).nullable(),
  review: z.enum(TASK_REVIEW_MODES),
};
export const TaskPatchSchema = z.object(TaskFields).partial().strict();
export const NewTaskSchema = z
  .object({ ...TaskFields, key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/i).optional() })
  .partial({ dependsOn: true, model: true, effort: true, review: true, key: true })
  .strict();

export const MoveSchema = z.object({ phaseId: z.string(), idx: z.number().int().min(0) }).strict();
export const PhaseInputSchema = z.object({ title: z.string().trim().min(1), goal: z.string().trim().min(1) }).strict();
export const PhasePatchSchema = PhaseInputSchema.partial().strict();
const RequiredTask = z
  .object({ ...TaskFields, key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/i).optional() })
  .partial({ dependsOn: true, model: true, effort: true, review: true, key: true })
  .strict();
export const NewPhaseSchema = PhaseInputSchema.extend({ firstTask: RequiredTask }).strict();

// ─────────── helpers ───────────

function phaseWithProject(db: DbOrTx, phaseId: string): { phase: Phase; project: Project } {
  const phase = db.select().from(phases).where(eq(phases.id, phaseId)).get();
  if (!phase) throw new Error(`phase not found: ${phaseId}`);
  return { phase, project: getProject(db, phase.projectId) };
}

function taskWithContext(db: DbOrTx, taskId: string): { task: Task; phase: Phase; project: Project } {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new Error(`task not found: ${taskId}`);
  const { phase, project } = phaseWithProject(db, task.phaseId);
  return { task, phase, project };
}

function assertProjectEditable(project: Project) {
  if (!PROJECT_EDITABLE(project)) throw new EditRefused(`the plan of ${project.slug} cannot be edited while it is ${project.status}`);
}

const projectPhases = (db: DbOrTx, projectId: string) => db.select().from(phases).where(eq(phases.projectId, projectId)).orderBy(asc(phases.idx)).all();
const projectTasks = (db: DbOrTx, phaseIds: string[]) => (phaseIds.length ? db.select().from(tasks).where(inArray(tasks.phaseId, phaseIds)).orderBy(asc(tasks.idx)).all() : []);

/** Whole-plan validation with problems the UI can point at. */
export function validateStoredPlan(db: DbOrTx, projectId: string): PlanProblem[] {
  const ph = projectPhases(db, projectId);
  const ts = projectTasks(db, ph.map((p) => p.id));
  const keyOf = new Map(ts.map((t) => [t.id, t.key]));
  const phaseIdxOf = new Map(ph.map((p) => [p.id, p.idx]));
  const problems: PlanProblem[] = [];
  const seen = new Map<string, number>();

  for (const p of ph) {
    const own = ts.filter((t) => t.phaseId === p.id);
    if (!own.length) problems.push({ message: `Phase ${p.idx} has no tasks`, phaseIdx: p.idx });
  }
  for (const t of ts) {
    const pi = phaseIdxOf.get(t.phaseId)!;
    if (seen.has(t.key)) problems.push({ message: `Duplicate task key ${t.key}`, taskKey: t.key, phaseIdx: pi, field: "key" });
    seen.set(t.key, pi);
    if (!t.spec.trim()) problems.push({ message: `${t.key} has no spec`, taskKey: t.key, phaseIdx: pi, field: "spec" });
    if (!t.acceptance.length) problems.push({ message: `${t.key} needs at least one acceptance criterion`, taskKey: t.key, phaseIdx: pi, field: "acceptance" });
    if (!t.verifyCommands.length) problems.push({ message: `${t.key} needs at least one verify command`, taskKey: t.key, phaseIdx: pi, field: "verifyCommands" });
    for (const c of t.verifyCommands) {
      if (FORBIDDEN_COMMAND.test(c)) problems.push({ message: `${t.key}: "${c}" is interactive or unsafe for the gate`, taskKey: t.key, phaseIdx: pi, field: "verifyCommands" });
    }
  }
  for (const t of ts) {
    const pi = phaseIdxOf.get(t.phaseId)!;
    for (const d of t.dependsOn) {
      const dk = keyOf.get(d);
      if (d === t.id) problems.push({ message: `${t.key} depends on itself`, taskKey: t.key, phaseIdx: pi, field: "dependsOn" });
      else if (!dk) problems.push({ message: `${t.key} depends on a task that no longer exists`, taskKey: t.key, phaseIdx: pi, field: "dependsOn" });
      else {
        const dp = seen.get(dk)!;
        if (dp > pi) problems.push({ message: `${t.key} (phase ${pi}) depends on ${dk} from a later phase ${dp}`, taskKey: t.key, phaseIdx: pi, field: "dependsOn" });
      }
    }
  }
  const plan = {
    phases: ph.map((p) => ({
      title: p.title,
      goal: p.goal,
      tasks: ts.filter((t) => t.phaseId === p.id).map((t) => ({ key: t.key, title: t.title, spec: t.spec, acceptance: t.acceptance, verify_commands: t.verifyCommands, depends_on: t.dependsOn.map((d) => keyOf.get(d) ?? d) })),
    })),
  };
  const cycle = findCycle(plan);
  if (cycle) problems.push({ message: `Dependency cycle: ${cycle.join(" → ")}`, taskKey: cycle[0], field: "dependsOn" });
  return problems;
}

/** After an edit: tasks of started phases follow their dependencies (ready ⇄ pending). */
function settleReadiness(db: DbOrTx, projectId: string) {
  const ph = projectPhases(db, projectId);
  const ts = projectTasks(db, ph.map((p) => p.id));
  const done = new Set(ts.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id));
  const started = new Set(ph.filter((p) => p.status === "active").map((p) => p.id));
  for (const t of ts) {
    if (t.status === "ready" && !t.dependsOn.every((d) => done.has(d))) db.update(tasks).set({ status: "pending" }).where(eq(tasks.id, t.id)).run();
  }
  const release = tasksToRelease(ts.map((t) => (t.status === "ready" && !t.dependsOn.every((d) => done.has(d)) ? { ...t, status: "pending" as const } : t)));
  for (const t of release) if (started.has(t.phaseId)) db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, t.id)).run();
}

function reindex(db: DbOrTx, phaseId: string, order: string[]) {
  // Two passes: idx has no unique constraint, but keep it dense and in the requested order.
  order.forEach((id, i) => db.update(tasks).set({ idx: i + 1, phaseId }).where(eq(tasks.id, id)).run());
}

/** Run an edit: check the project, apply, validate the whole plan (roll back on problems), settle, log. */
function edit<T>(db: Db, projectId: string, op: string, info: Record<string, unknown>, apply: (tx: DbOrTx, project: Project) => T): T {
  return db.transaction((tx) => {
    const project = getProject(tx, projectId);
    assertProjectEditable(project);
    const result = apply(tx, project);
    const problems = validateStoredPlan(tx, project.id);
    if (problems.length) throw new PlanInvalid(problems);
    settleReadiness(tx, project.id);
    logEvent(tx, project.id, "plan_edited", { op, ...info });
    return result;
  });
}

function uniqueKey(db: DbOrTx, phaseIds: string[], base: string): string {
  const taken = new Set(projectTasks(db, phaseIds).map((t) => t.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ─────────── operations ───────────

export function updateTask(db: Db, taskId: string, input: z.infer<typeof TaskPatchSchema>) {
  const patch = TaskPatchSchema.parse(input);
  const { task, phase, project } = taskWithContext(db, taskId);
  const lock = taskLock(task);
  if (lock) throw new EditRefused(`${task.key} cannot be edited (${lock.replace("_", " ")})`);
  return edit(db, project.id, "task_update", { taskKey: task.key, phaseIdx: phase.idx, fields: Object.keys(patch) }, (tx) => {
    const set: Partial<Task> = { ...patch } as Partial<Task>;
    if ("model" in patch || "effort" in patch) set.modelSource = patch.model === null ? "planner" : "owner";
    if (patch.model === null) set.effort = null;
    tx.update(tasks).set(set).where(eq(tasks.id, task.id)).run();
  });
}

export function addTask(db: Db, phaseId: string, input: z.infer<typeof NewTaskSchema>) {
  const t = NewTaskSchema.parse(input);
  const { phase, project } = phaseWithProject(db, phaseId);
  const lock = phaseLock(phase, "add_task");
  if (lock) throw new EditRefused(`phase ${phase.idx} cannot get new tasks (${lock.replace("_", " ")})`);
  return edit(db, project.id, "task_add", { phaseIdx: phase.idx, title: t.title }, (tx) => {
    const ids = projectPhases(tx, project.id).map((p) => p.id);
    const key = uniqueKey(tx, ids, t.key ?? `p${phase.idx}-${slugify(t.title)}`.slice(0, 40));
    if (t.key && key !== t.key) throw new PlanInvalid([{ message: `Task key ${t.key} is already used`, phaseIdx: phase.idx, field: "key" }]);
    const last = tx.select({ idx: tasks.idx }).from(tasks).where(eq(tasks.phaseId, phase.id)).orderBy(asc(tasks.idx)).all().at(-1)?.idx ?? 0;
    const row = tx
      .insert(tasks)
      .values({
        phaseId: phase.id,
        idx: last + 1,
        key,
        title: t.title,
        spec: t.spec,
        acceptance: t.acceptance,
        verifyCommands: t.verifyCommands,
        dependsOn: t.dependsOn ?? [],
        model: t.model ?? null,
        effort: t.effort ?? null,
        modelSource: t.model ? "owner" : "planner",
        review: t.review ?? "default",
        maxAttempts: profileOf(project).maxAttempts,
        status: "pending",
      })
      .returning()
      .get();
    return row;
  });
}

export function deleteTask(db: Db, taskId: string) {
  const { task, phase, project } = taskWithContext(db, taskId);
  const lock = taskLock(task);
  if (lock) throw new EditRefused(`${task.key} cannot be deleted (${lock.replace("_", " ")})`);
  return edit(db, project.id, "task_delete", { taskKey: task.key, phaseIdx: phase.idx }, (tx) => {
    const dependents = projectTasks(tx, projectPhases(tx, project.id).map((p) => p.id)).filter((t) => t.dependsOn.includes(task.id));
    if (dependents.length) {
      throw new PlanInvalid(dependents.map((d) => ({ message: `${d.key} depends on ${task.key}; remove that dependency first`, taskKey: d.key, field: "dependsOn" })));
    }
    tx.delete(tasks).where(eq(tasks.id, task.id)).run();
    reindex(tx, phase.id, tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.phaseId, phase.id)).orderBy(asc(tasks.idx)).all().map((r) => r.id));
  });
}

/** Move a task to `idx` (0-based) in a phase, possibly another one. */
export function moveTask(db: Db, taskId: string, input: z.infer<typeof MoveSchema>) {
  const to = MoveSchema.parse(input);
  const { task, phase: from, project } = taskWithContext(db, taskId);
  const lock = taskLock(task);
  if (lock) throw new EditRefused(`${task.key} cannot be moved (${lock.replace("_", " ")})`);
  const { phase: target, project: targetProject } = phaseWithProject(db, to.phaseId);
  if (targetProject.id !== project.id) throw new EditRefused("tasks can only move within the same project");
  const tl = phaseLock(target, "add_task");
  if (tl) throw new EditRefused(`phase ${target.idx} cannot take tasks (${tl.replace("_", " ")})`);
  return edit(db, project.id, "task_move", { taskKey: task.key, fromPhaseIdx: from.idx, phaseIdx: target.idx, idx: to.idx }, (tx) => {
    const ids = (pid: string) => tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.phaseId, pid)).orderBy(asc(tasks.idx)).all().map((r) => r.id).filter((id) => id !== task.id);
    const dest = ids(target.id);
    dest.splice(Math.min(to.idx, dest.length), 0, task.id);
    reindex(tx, target.id, dest);
    if (from.id !== target.id) reindex(tx, from.id, ids(from.id));
  });
}

/** Append a phase; it is created together with its first task, because a phase without tasks is invalid. */
export function addPhase(db: Db, projectId: string, input: z.infer<typeof NewPhaseSchema>) {
  const p = NewPhaseSchema.parse(input);
  const project = getProject(db, projectId);
  return edit(db, project.id, "phase_add", { title: p.title }, (tx, proj) => {
    const last = projectPhases(tx, proj.id).at(-1)?.idx ?? 0;
    const idx = last + 1;
    const phase = tx
      .insert(phases)
      .values({ projectId: proj.id, idx, title: p.title, goal: p.goal, status: "pending", branch: phaseBranch(proj, idx, slugify(p.title)) })
      .returning()
      .get();
    const t = p.firstTask;
    tx.insert(tasks)
      .values({
        phaseId: phase.id,
        idx: 1,
        key: uniqueKey(tx, projectPhases(tx, proj.id).map((x) => x.id), t.key ?? `p${idx}-${slugify(t.title)}`.slice(0, 40)),
        title: t.title,
        spec: t.spec,
        acceptance: t.acceptance,
        verifyCommands: t.verifyCommands,
        dependsOn: t.dependsOn ?? [],
        model: t.model ?? null,
        effort: t.effort ?? null,
        modelSource: t.model ? "owner" : "planner",
        review: t.review ?? "default",
        maxAttempts: profileOf(proj).maxAttempts,
        status: "pending",
      })
      .run();
    return phase;
  });
}

export function updatePhase(db: Db, phaseId: string, input: z.infer<typeof PhasePatchSchema>) {
  const patch = PhasePatchSchema.parse(input);
  const { phase, project } = phaseWithProject(db, phaseId);
  const lock = phaseLock(phase, "edit");
  if (lock) throw new EditRefused(`phase ${phase.idx} cannot be edited (${lock.replace("_", " ")})`);
  return edit(db, project.id, "phase_update", { phaseIdx: phase.idx, fields: Object.keys(patch) }, (tx) => {
    // The branch name follows the title only until the branch exists (phase not started).
    const branch = phase.status === "pending" && patch.title ? phaseBranch(project, phase.idx, slugify(patch.title)) : phase.branch;
    tx.update(phases).set({ ...patch, branch }).where(eq(phases.id, phase.id)).run();
  });
}

export function deletePhase(db: Db, phaseId: string) {
  const { phase, project } = phaseWithProject(db, phaseId);
  const lock = phaseLock(phase, "delete");
  if (lock) throw new EditRefused(`phase ${phase.idx} cannot be deleted (${lock.replace("_", " ")})`);
  return edit(db, project.id, "phase_delete", { phaseIdx: phase.idx, title: phase.title }, (tx) => {
    const own = tx.select({ id: tasks.id, key: tasks.key }).from(tasks).where(eq(tasks.phaseId, phase.id)).all();
    const ownIds = new Set(own.map((t) => t.id));
    const others = projectTasks(tx, projectPhases(tx, project.id).filter((p) => p.id !== phase.id).map((p) => p.id));
    const blocking = others.filter((t) => t.dependsOn.some((d) => ownIds.has(d)));
    if (blocking.length) {
      throw new PlanInvalid(blocking.map((t) => ({ message: `${t.key} depends on a task in phase ${phase.idx}; remove that dependency first`, taskKey: t.key, field: "dependsOn" })));
    }
    tx.delete(tasks).where(eq(tasks.phaseId, phase.id)).run();
    tx.delete(phases).where(eq(phases.id, phase.id)).run();
    // Later phases (all pending, since phases run in order) close the gap; their branches do not exist yet.
    for (const p of projectPhases(tx, project.id).filter((x) => x.idx > phase.idx)) {
      tx.update(phases).set({ idx: p.idx - 1, branch: phaseBranch(project, p.idx - 1, slugify(p.title)) }).where(eq(phases.id, p.id)).run();
    }
  });
}

/** Owner gate: the plan is approved (as edited) and execution may start. */
export function approvePlan(db: Db, projectId: string): Project {
  return db.transaction((tx) => {
    const project = getProject(tx, projectId);
    if (project.status !== "awaiting_owner" || project.ownerGate !== "approve_plan") {
      throw new EditRefused(`${project.slug} is not waiting for plan approval`);
    }
    const problems = validateStoredPlan(tx, project.id);
    if (problems.length) throw new PlanInvalid(problems);
    assertReadyToApprove(project);
    recordUserAnswer(tx, project, "plan", "The owner approved the plan.", "approve");
    logEvent(tx, project.id, "plan_approved_by_owner", {});
    return applyProjectEvent(tx, project, { type: "owner_decided" });
  });
}


/** Owner actions on single tasks (dashboard: retry / skip). */
import { and, eq, inArray } from "drizzle-orm";
import { transitionTask, type TaskEvent } from "../core/stateMachines.js";
import type { Db, DbOrTx } from "../db/index.js";
import { phases, tasks, type Project, type Task } from "../db/schema.js";
import { recordUserAnswer } from "../loops/review.js";
import { applyProjectEvent, getProject, logEvent } from "./repo.js";

function taskWithProject(db: DbOrTx, taskId: string): { task: Task; project: Project } {
  const row = db.select({ task: tasks, projectId: phases.projectId }).from(tasks).innerJoin(phases, eq(tasks.phaseId, phases.id)).where(eq(tasks.id, taskId)).get();
  if (!row) throw new Error(`task not found: ${taskId}`);
  return { task: row.task, project: getProject(db, row.projectId) };
}

/** When the owner fixed the last stuck task, an execution block is lifted. */
function unblockIfClear(db: DbOrTx, project: Project): Project {
  if (project.status !== "blocked" || project.blockedFrom !== "executing") return project;
  const stuck = db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(phases, eq(tasks.phaseId, phases.id))
    .where(and(eq(phases.projectId, project.id), inArray(tasks.status, ["failed", "escalated"])))
    .all().length;
  const blockedPhases = db.select({ id: phases.id }).from(phases).where(and(eq(phases.projectId, project.id), eq(phases.status, "blocked"))).all().length;
  return stuck || blockedPhases ? project : applyProjectEvent(db, project, { type: "unblock" });
}

function apply(db: Db, taskId: string, e: TaskEvent, note?: string): { task: Task; project: Project } {
  return db.transaction((tx) => {
    const { task, project } = taskWithProject(tx, taskId);
    const next = transitionTask(
      { status: task.status, attempts: task.attempts, maxAttempts: task.maxAttempts, sessionId: task.sessionId, lastFeedback: task.lastFeedback },
      e,
    );
    const row = tx.update(tasks).set(next).where(eq(tasks.id, task.id)).returning().get();
    if (note) recordUserAnswer(tx, project, "task", note, e.type === "skip" ? "approve" : "rework", { phaseId: task.phaseId, taskId: task.id });
    logEvent(tx, project.id, "task_status", { taskId: task.id, key: task.key, from: task.status, to: row.status, event: e.type, by: "owner" });
    return { task: row, project: unblockIfClear(tx, getProject(tx, project.id)) };
  });
}

/** Fresh attempt budget; the optional message is passed to the worker as feedback. */
export function retryTask(db: Db, taskId: string, message?: string) {
  const feedback = message ? `Note from the project owner: ${message}` : undefined;
  return apply(db, taskId, { type: "user_retry", feedback }, message);
}

/** Mark a task as not needed; tasks depending on it are released. */
export function skipTask(db: Db, taskId: string, reason?: string) {
  return apply(db, taskId, { type: "skip" }, reason ? `Skipped by the owner: ${reason}` : "Skipped by the owner");
}

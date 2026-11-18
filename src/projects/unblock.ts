import { and, eq, inArray } from "drizzle-orm";
import { transitionPhase, transitionTask } from "../core/stateMachines.js";
import { phases, tasks, type Project } from "../db/schema.js";
import type { LoopDeps, ReviewTarget } from "../loops/common.js";
import { recordUserAnswer } from "../loops/review.js";
import { applyProjectEvent, getProject, logEvent } from "./repo.js";

const TARGET_BY_STAGE: Partial<Record<Project["status"], ReviewTarget>> = {
  architecting: "architecture",
  planning: "plan",
};

/**
 * Answer a blocked project. The message becomes feedback for the next author
 * run where it blocked, with a fresh attempt budget:
 * - architecting/planning: next architect/planner run,
 * - executing: every escalated or failed task is retried with the answer;
 *   a blocked phase goes back to review with the answer in its history.
 */
export function answerAndUnblock(deps: Pick<LoopDeps, "db">, idOrSlug: string, message: string): Project {
  const project = getProject(deps.db, idOrSlug);
  if (project.status !== "blocked" || !project.blockedFrom) throw new Error(`project ${project.slug} is not blocked`);

  return deps.db.transaction((tx) => {
    const target = TARGET_BY_STAGE[project.blockedFrom!];
    if (target) recordUserAnswer(tx, project, target, message);

    if (project.blockedFrom === "executing") {
      const stuck = tx
        .select({ t: tasks })
        .from(tasks)
        .innerJoin(phases, eq(tasks.phaseId, phases.id))
        .where(and(eq(phases.projectId, project.id), inArray(tasks.status, ["escalated", "failed"])))
        .all()
        .map((r) => r.t);
      for (const t of stuck) {
        const next = transitionTask(
          { status: t.status, attempts: t.attempts, maxAttempts: t.maxAttempts, sessionId: t.sessionId, lastFeedback: t.lastFeedback },
          { type: "user_retry", feedback: `${t.lastFeedback ? `${t.lastFeedback}\n\n` : ""}Answer from the project owner: ${message}` },
        );
        tx.update(tasks).set(next).where(eq(tasks.id, t.id)).run();
        recordUserAnswer(tx, project, "task", message, "rework", { phaseId: t.phaseId, taskId: t.id });
      }
      const blockedPhases = tx.select().from(phases).where(and(eq(phases.projectId, project.id), eq(phases.status, "blocked"))).all();
      for (const ph of blockedPhases) {
        tx.update(phases).set({ status: transitionPhase(ph.status, { type: "unblock" }) }).where(eq(phases.id, ph.id)).run();
        recordUserAnswer(tx, project, "phase", message, "rework", { phaseId: ph.id });
      }
    }

    logEvent(tx, project.id, "owner_answer", { message, stage: project.blockedFrom });
    return applyProjectEvent(tx, project, { type: "unblock" });
  });
}

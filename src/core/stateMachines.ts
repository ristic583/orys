/**
 * Pure state transitions for tasks, phases and projects (SPEC §5).
 * No I/O: callers load state, apply an event, persist the result.
 */
import type { Decision, OwnerGate, PhaseStatus, ProjectStatus, TaskStatus } from "./types.js";
import { STARTABLE_TASK_STATUSES } from "./types.js";

export class InvalidTransition extends Error {
  constructor(entity: string, from: string, event: string) {
    super(`${entity}: event "${event}" is not allowed in status "${from}"`);
    this.name = "InvalidTransition";
  }
}

// ───────────────────────────── Task ─────────────────────────────

export type TaskState = {
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  sessionId: string | null;
  lastFeedback: string | null;
};

export type TaskEvent =
  | { type: "deps_satisfied" }
  | { type: "start" }
  | { type: "worker_finished"; sessionId: string }
  /** Worker crashed or timed out: costs an attempt. */
  | { type: "worker_failed"; sessionId?: string; feedback: string }
  /** Limit, auth problem or app restart: no attempt is used. */
  | { type: "interrupt"; sessionId?: string }
  | { type: "verify_failed"; feedback: string }
  /** The gate failed, but the same command also fails on the task's base commit: the reviewer decides, no attempt used. */
  | { type: "verify_disputed"; feedback: string }
  | { type: "verify_passed"; reviewRequired: boolean }
  | { type: "review"; decision: Decision; feedback: string }
  /** User answers an escalation, retries a failed task, or retries manually. */
  | { type: "user_retry"; feedback?: string }
  | { type: "skip" };

/** Use one attempt; fall into `failed` when attempts are exhausted. */
function consumeAttempt(s: TaskState, feedback: string, sessionId?: string): TaskState {
  const attempts = s.attempts + 1;
  return {
    ...s,
    attempts,
    sessionId: sessionId ?? s.sessionId,
    lastFeedback: feedback,
    status: attempts >= s.maxAttempts ? "failed" : "rework",
  };
}

export function transitionTask(s: TaskState, e: TaskEvent): TaskState {
  const bad = () => new InvalidTransition("task", s.status, e.type);
  switch (e.type) {
    case "deps_satisfied":
      if (s.status !== "pending") throw bad();
      return { ...s, status: "ready" };

    case "start":
      if (!STARTABLE_TASK_STATUSES.includes(s.status)) throw bad();
      return { ...s, status: "running" };

    case "worker_finished":
      if (s.status !== "running") throw bad();
      return { ...s, status: "verifying", sessionId: e.sessionId };

    case "worker_failed":
      if (s.status !== "running") throw bad();
      return consumeAttempt(s, e.feedback, e.sessionId);

    case "interrupt":
      if (!["running", "verifying", "reviewing"].includes(s.status)) throw bad();
      return { ...s, status: "interrupted", sessionId: e.sessionId ?? s.sessionId };

    case "verify_failed":
      if (s.status !== "verifying") throw bad();
      return consumeAttempt(s, e.feedback);

    case "verify_disputed":
      if (s.status !== "verifying") throw bad();
      return { ...s, status: "reviewing", lastFeedback: e.feedback };

    case "verify_passed":
      if (s.status !== "verifying") throw bad();
      return { ...s, status: e.reviewRequired ? "reviewing" : "done", lastFeedback: null };

    case "review":
      if (s.status !== "reviewing") throw bad();
      if (e.decision === "approve") return { ...s, status: "done", lastFeedback: null };
      if (e.decision === "escalate") return { ...s, status: "escalated", lastFeedback: e.feedback };
      return consumeAttempt(s, e.feedback);

    case "user_retry":
      if (!["failed", "escalated", "rework", "interrupted"].includes(s.status)) throw bad();
      // A fresh budget of attempts: the user has looked at it.
      return { ...s, status: "rework", attempts: 0, lastFeedback: e.feedback ?? s.lastFeedback };

    case "skip":
      if (["running", "verifying", "reviewing", "done"].includes(s.status)) throw bad();
      return { ...s, status: "skipped" };
  }
}

// ───────────────────────────── Phase ─────────────────────────────

export type PhaseEvent =
  | { type: "activate" }
  | { type: "all_tasks_done" }
  | { type: "review"; decision: Decision }
  | { type: "unblock" };

/**
 * Phase review `rework` sends the phase back to `active`; the caller adds a
 * fix-up task carrying the reviewer's feedback.
 */
export function transitionPhase(s: PhaseStatus, e: PhaseEvent): PhaseStatus {
  const bad = () => new InvalidTransition("phase", s, e.type);
  switch (e.type) {
    case "activate":
      if (s !== "pending") throw bad();
      return "active";
    case "all_tasks_done":
      if (s !== "active") throw bad();
      return "reviewing";
    case "review":
      if (s !== "reviewing") throw bad();
      return e.decision === "approve" ? "done" : e.decision === "rework" ? "active" : "blocked";
    case "unblock":
      if (s !== "blocked") throw bad();
      return "reviewing";
  }
}

// ───────────────────────────── Project ─────────────────────────────

export type ProjectState = {
  status: ProjectStatus;
  /** Status to return to when unblocked. */
  blockedFrom: ProjectStatus | null;
  blockedReason: string | null;
  /** Pending owner decision while status is awaiting_owner. */
  ownerGate: OwnerGate | null;
};

export type ProjectEvent =
  /** Scratch projects start with the architect; existing repos with the mapper. */
  | { type: "start"; firstStage?: "architecting" | "mapping" | "sketching" }
  | { type: "architecture_approved" }
  /** The mapper's map was approved; the owner picks what to do next (no gate: the goal is already agreed, e.g. by a sketch). */
  | { type: "map_approved"; gate: "pick_proposals" | "confirm_goal" | null }
  /** Sketch v(n) is ready: the owner reacts (approve_sketch). */
  | { type: "sketch_ready" }
  /** The owner asked for another version of the sketch. */
  | { type: "sketch_revise" }
  /** Agreed (or nothing to show): on to the full map / architecture for big work, else straight to the plan. */
  | { type: "sketch_done"; next: "mapping" | "architecting" | "planning" }
  | { type: "plan_approved" }
  /** Pause for an owner decision (e.g. approve the plan before execution). */
  | { type: "await_owner"; gate: OwnerGate }
  | { type: "owner_decided"; next?: "sketching" }
  | { type: "all_phases_done" }
  | { type: "block"; reason: string }
  | { type: "unblock" }
  /** Architecture must be redone (e.g. the plan review found it unworkable). */
  | { type: "rearchitect" }
  /** The owner sent the finished result back: a feedback phase runs. */
  | { type: "reopen" };

/** Where the project continues after each owner decision. */
const AFTER_GATE: Record<OwnerGate, ProjectStatus> = {
  pick_proposals: "planning",
  confirm_goal: "planning",
  approve_sketch: "planning",
  approve_plan: "executing",
};

export function transitionProject(s: ProjectState, e: ProjectEvent): ProjectState {
  const bad = () => new InvalidTransition("project", s.status, e.type);
  const to = (status: ProjectStatus): ProjectState => ({ status, blockedFrom: null, blockedReason: null, ownerGate: null });
  switch (e.type) {
    case "start":
      if (s.status !== "draft") throw bad();
      return to(e.firstStage ?? "architecting");
    case "architecture_approved":
      if (s.status !== "architecting") throw bad();
      return to("planning");
    case "map_approved":
      if (s.status !== "mapping") throw bad();
      return e.gate ? { ...to("awaiting_owner"), ownerGate: e.gate } : to("planning");
    case "sketch_ready":
      if (s.status !== "sketching") throw bad();
      return { ...to("awaiting_owner"), ownerGate: "approve_sketch" };
    case "sketch_revise":
      if (s.status !== "awaiting_owner" || s.ownerGate !== "approve_sketch") throw bad();
      return to("sketching");
    case "sketch_done":
      if (s.status !== "sketching" && !(s.status === "awaiting_owner" && s.ownerGate === "approve_sketch")) throw bad();
      return to(e.next);
    case "plan_approved":
      if (s.status !== "planning") throw bad();
      return to("executing");
    case "await_owner":
      if (s.status !== "planning" && s.status !== "mapping") throw bad();
      return { ...to("awaiting_owner"), ownerGate: e.gate };
    case "owner_decided":
      if (s.status !== "awaiting_owner" || !s.ownerGate) throw bad();
      return to(e.next ?? AFTER_GATE[s.ownerGate]);
    case "all_phases_done":
      if (s.status !== "executing") throw bad();
      return to("done");
    case "reopen":
      if (s.status !== "done") throw bad();
      return to("executing");
    case "rearchitect":
      if (s.status !== "planning") throw bad();
      return to("architecting");
    case "block":
      if (s.status === "draft" || s.status === "done" || s.status === "blocked") throw bad();
      // An open owner gate is kept so unblocking returns to the same decision.
      return { status: "blocked", blockedFrom: s.status, blockedReason: e.reason, ownerGate: s.ownerGate };
    case "unblock":
      if (s.status !== "blocked" || !s.blockedFrom) throw bad();
      return { ...to(s.blockedFrom), ownerGate: s.blockedFrom === "awaiting_owner" ? s.ownerGate : null };
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

/** Tasks in `pending` whose dependencies are all satisfied. */
export function tasksToRelease<T extends { id: string; status: TaskStatus; dependsOn: string[] }>(tasks: T[]): T[] {
  const satisfied = new Set(tasks.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id));
  return tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => satisfied.has(d)));
}

/** A phase is finished when every task is done or skipped. */
export function phaseComplete(tasks: { status: TaskStatus }[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "skipped");
}

/**
 * On app start a worker that was `running` is gone → `interrupted`.
 * `verifying`/`reviewing` are idempotent and are simply resumed by the next step.
 */
export function recoverAfterRestart(s: TaskState): TaskState {
  return s.status === "running" ? transitionTask(s, { type: "interrupt" }) : s;
}

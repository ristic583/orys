import { describe, expect, it } from "vitest";
import {
  InvalidTransition,
  phaseComplete,
  recoverAfterRestart,
  tasksToRelease,
  transitionPhase,
  transitionProject,
  transitionTask,
  type ProjectState,
  type TaskEvent,
  type TaskState,
} from "../src/core/stateMachines.js";
import { PROFILES, resolveWorker } from "../src/core/profiles.js";

const task = (over: Partial<TaskState> = {}): TaskState => ({
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
  sessionId: null,
  lastFeedback: null,
  ...over,
});
const run = (s: TaskState, ...events: TaskEvent[]) => events.reduce(transitionTask, s);

describe("task state machine", () => {
  it("happy path with review", () => {
    const s = run(
      task(),
      { type: "deps_satisfied" },
      { type: "start" },
      { type: "worker_finished", sessionId: "s1" },
      { type: "verify_passed", reviewRequired: true },
      { type: "review", decision: "approve", feedback: "" },
    );
    expect(s).toMatchObject({ status: "done", attempts: 0, sessionId: "s1", lastFeedback: null });
  });

  it("skips review when the profile does not require it", () => {
    const s = run(task({ status: "ready" }), { type: "start" }, { type: "worker_finished", sessionId: "s" }, { type: "verify_passed", reviewRequired: false });
    expect(s.status).toBe("done");
  });

  it("failed verification goes to rework with feedback and keeps the session for --resume", () => {
    const s = run(task({ status: "ready" }), { type: "start" }, { type: "worker_finished", sessionId: "s1" }, { type: "verify_failed", feedback: "pnpm test: 2 failed" });
    expect(s).toMatchObject({ status: "rework", attempts: 1, sessionId: "s1", lastFeedback: "pnpm test: 2 failed" });
    expect(transitionTask(s, { type: "start" }).status).toBe("running");
  });

  it("fails after maxAttempts", () => {
    let s = task({ status: "ready", maxAttempts: 2 });
    for (let i = 0; i < 2; i++) s = run(s, { type: "start" }, { type: "worker_finished", sessionId: "s" }, { type: "verify_failed", feedback: `f${i}` });
    expect(s).toMatchObject({ status: "failed", attempts: 2, lastFeedback: "f1" });
    expect(() => transitionTask(s, { type: "start" })).toThrow(InvalidTransition);
  });

  it("review rework and crash both consume attempts", () => {
    const reviewed = run(task({ status: "ready" }), { type: "start" }, { type: "worker_finished", sessionId: "s" }, { type: "verify_passed", reviewRequired: true }, { type: "review", decision: "rework", feedback: "missing validation" });
    expect(reviewed).toMatchObject({ status: "rework", attempts: 1, lastFeedback: "missing validation" });
    const crashed = run(task({ status: "ready" }), { type: "start" }, { type: "worker_failed", feedback: "timeout" });
    expect(crashed).toMatchObject({ status: "rework", attempts: 1 });
  });

  it("interrupt (limit/auth/restart) does not consume an attempt and is startable", () => {
    const s = run(task({ status: "ready" }), { type: "start" }, { type: "interrupt", sessionId: "s9" });
    expect(s).toMatchObject({ status: "interrupted", attempts: 0, sessionId: "s9" });
    expect(transitionTask(s, { type: "start" }).status).toBe("running");
  });

  it("escalation waits for the user, who retries with a fresh attempt budget", () => {
    const esc = run(task({ status: "ready", attempts: 2 }), { type: "start" }, { type: "worker_finished", sessionId: "s" }, { type: "verify_passed", reviewRequired: true }, { type: "review", decision: "escalate", feedback: "which payment provider?" });
    expect(esc.status).toBe("escalated");
    expect(() => transitionTask(esc, { type: "start" })).toThrow(InvalidTransition);
    const retried = transitionTask(esc, { type: "user_retry", feedback: "use Stripe" });
    expect(retried).toMatchObject({ status: "rework", attempts: 0, lastFeedback: "use Stripe" });
  });

  it("cannot skip a task that is in flight", () => {
    expect(() => transitionTask(task({ status: "running" }), { type: "skip" })).toThrow(InvalidTransition);
    expect(transitionTask(task({ status: "failed" }), { type: "skip" }).status).toBe("skipped");
  });

  it("after restart only a running worker becomes interrupted; gate and review resume as they are", () => {
    expect(recoverAfterRestart(task({ status: "running" })).status).toBe("interrupted");
    for (const status of ["verifying", "reviewing", "done"] as const) expect(recoverAfterRestart(task({ status })).status).toBe(status);
  });
});

describe("dependency helpers", () => {
  it("releases pending tasks whose deps are done or skipped", () => {
    const tasks = [
      { id: "a", status: "done" as const, dependsOn: [] },
      { id: "b", status: "skipped" as const, dependsOn: [] },
      { id: "c", status: "pending" as const, dependsOn: ["a", "b"] },
      { id: "d", status: "pending" as const, dependsOn: ["c"] },
    ];
    expect(tasksToRelease(tasks).map((t) => t.id)).toEqual(["c"]);
    expect(phaseComplete(tasks)).toBe(false);
    expect(phaseComplete([{ status: "done" }, { status: "skipped" }])).toBe(true);
    expect(phaseComplete([])).toBe(false);
  });
});

describe("phase state machine", () => {
  it("activates, reviews, and loops back on rework", () => {
    expect(transitionPhase("pending", { type: "activate" })).toBe("active");
    expect(transitionPhase("active", { type: "all_tasks_done" })).toBe("reviewing");
    expect(transitionPhase("reviewing", { type: "review", decision: "rework" })).toBe("active");
    expect(transitionPhase("reviewing", { type: "review", decision: "approve" })).toBe("done");
    expect(transitionPhase("reviewing", { type: "review", decision: "escalate" })).toBe("blocked");
    expect(transitionPhase("blocked", { type: "unblock" })).toBe("reviewing");
    expect(() => transitionPhase("done", { type: "activate" })).toThrow(InvalidTransition);
  });
});

describe("project state machine", () => {
  const p = (status: ProjectState["status"], ownerGate: ProjectState["ownerGate"] = null): ProjectState => ({ status, blockedFrom: null, blockedReason: null, ownerGate });

  it("walks the main path", () => {
    let s = p("draft");
    for (const type of ["start", "architecture_approved", "plan_approved", "all_phases_done"] as const) s = transitionProject(s, { type });
    expect(s.status).toBe("done");
  });

  it("blocks and returns to where it was", () => {
    const blocked = transitionProject(p("executing"), { type: "block", reason: "task failed 3x" });
    expect(blocked).toEqual({ status: "blocked", blockedFrom: "executing", blockedReason: "task failed 3x", ownerGate: null });
    expect(transitionProject(blocked, { type: "unblock" }).status).toBe("executing");
    expect(() => transitionProject(blocked, { type: "block", reason: "again" })).toThrow(InvalidTransition);
    expect(() => transitionProject(p("draft"), { type: "block", reason: "x" })).toThrow(InvalidTransition);
  });

  it("existing repos start with the mapper and pause for the owner's pick", () => {
    let s = transitionProject(p("draft"), { type: "start", firstStage: "mapping" });
    expect(s.status).toBe("mapping");
    s = transitionProject(s, { type: "map_approved", gate: "pick_proposals" });
    expect(s).toMatchObject({ status: "awaiting_owner", ownerGate: "pick_proposals" });
    s = transitionProject(s, { type: "owner_decided" });
    expect(s).toMatchObject({ status: "planning", ownerGate: null });
    s = transitionProject(s, { type: "await_owner", gate: "approve_plan" });
    expect(transitionProject(s, { type: "owner_decided" }).status).toBe("executing");
  });

  it("a block while waiting for the owner keeps the open gate", () => {
    const blocked = transitionProject(p("awaiting_owner", "confirm_goal"), { type: "block", reason: "repo moved" });
    expect(transitionProject(blocked, { type: "unblock" })).toMatchObject({ status: "awaiting_owner", ownerGate: "confirm_goal" });
    expect(() => transitionProject(p("executing"), { type: "owner_decided" })).toThrow(InvalidTransition);
  });

  it("can go back from planning to architecting", () => {
    expect(transitionProject(p("planning"), { type: "rearchitect" }).status).toBe("architecting");
  });
});

describe("profiles", () => {
  it("clamps planner suggestions into the profile range", () => {
    expect(resolveWorker(PROFILES.cost, { model: "opus", effort: "high" })).toEqual({ model: "sonnet", effort: "medium" });
    expect(resolveWorker(PROFILES.quality, { model: "haiku" })).toEqual({ model: "sonnet", effort: "high" });
    expect(resolveWorker(PROFILES.balanced, { model: "opus", effort: "low" })).toEqual({ model: "opus", effort: "low" });
    expect(resolveWorker(PROFILES.speed)).toEqual({ model: "sonnet", effort: "low" });
  });
});

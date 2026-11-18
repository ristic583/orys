import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "../src/db/index.js";
import { advanceExecution } from "../src/loops/execution.js";
import { effectiveRoles } from "../src/loops/common.js";
import * as editor from "../src/projects/planEditor.js";
import { getProject } from "../src/projects/repo.js";
import { updateProjectSettings } from "../src/projects/settings.js";
import { buildServer } from "../src/server/index.js";
import { review, setup, worker } from "./helpers.js";

/** A planned project waiting at the approve-plan gate (phase 1: p1-a, p1-b→p1-a; phase 2: p2-c→p1-b). */
const atGate = (script: Parameters<typeof setup>[0] = [], profile: "balanced" | "cost" = "balanced") => setup(script, { approve: false, profile });
const problemsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof editor.PlanInvalid) return e.problems;
    throw e;
  }
  throw new Error("expected PlanInvalid");
};

describe("approve-plan gate", () => {
  it("execution starts only after the owner approves; edits need an editable state", async () => {
    const { db, deps, project, task, workerCalls } = await atGate([worker(["a.txt"]), review("approve")]);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    expect((await advanceExecution(deps, project.id)).status).toBe("idle");
    expect(workerCalls()).toHaveLength(0);

    editor.updateTask(db, task("p1-a").id, { spec: "create a.txt with one line" });
    expect(editor.approvePlan(db, project.id).status).toBe("executing");
    expect(() => editor.approvePlan(db, project.id)).toThrow(editor.EditRefused);
    await advanceExecution(deps, project.id);
    expect(workerCalls()[0]!.prompt).toContain("create a.txt with one line");
    expect(task("p1-a").status).toBe("done");
  });
});

describe("plan edits", () => {
  it("rejects cycles and forward dependencies with pointable problems, and rolls back", async () => {
    const { db, task } = await atGate();
    const a = task("p1-a");
    const cycle = problemsOf(() => editor.updateTask(db, a.id, { dependsOn: [task("p1-b").id] }));
    expect(cycle[0]).toMatchObject({ field: "dependsOn", message: expect.stringMatching(/cycle: p1-[ab] → p1-[ab] → p1-[ab]/) });
    const forward = problemsOf(() => editor.updateTask(db, a.id, { dependsOn: [task("p2-c").id] }));
    expect(forward).toContainEqual({ message: "p1-a (phase 1) depends on p2-c from a later phase 2", taskKey: "p1-a", phaseIdx: 1, field: "dependsOn" });
    expect(task("p1-a").dependsOn).toEqual([]); // rolled back
    const unsafe = problemsOf(() => editor.updateTask(db, a.id, { verifyCommands: ["npm run dev"] }));
    expect(unsafe[0]).toMatchObject({ taskKey: "p1-a", field: "verifyCommands" });
  });

  it("adds, moves and deletes tasks; dependents protect a task from deletion", async () => {
    const { db, project, task } = await atGate();
    const phases = () => db.select().from(schema.phases).where(eq(schema.phases.projectId, project.id)).all().sort((x, y) => x.idx - y.idx);
    const [p1, p2] = phases();

    const blocked = problemsOf(() => editor.deleteTask(db, task("p1-b").id));
    expect(blocked).toEqual([{ message: "p2-c depends on p1-b; remove that dependency first", taskKey: "p2-c", field: "dependsOn" }]);

    const added = editor.addTask(db, p1!.id, { title: "Write a README", spec: "Add README.md", acceptance: ["README exists"], verifyCommands: ["test -f README.md"], dependsOn: [task("p1-a").id] });
    expect(added).toMatchObject({ key: "p1-write-a-readme", idx: 3, status: "pending" });

    editor.moveTask(db, task("p1-b").id, { phaseId: p2!.id, idx: 0 });
    expect(task("p1-b")).toMatchObject({ phaseId: p2!.id, idx: 1 });
    expect(task("p2-c").idx).toBe(2);
    expect(task("p1-write-a-readme").idx).toBe(2); // phase 1 closed the gap

    editor.deleteTask(db, task("p2-c").id);
    expect(task("p2-c")).toBeUndefined();
  });

  it("adds a phase with its first task, renames it, and deleting a phase renumbers later ones", async () => {
    const { db, project, task } = await atGate();
    editor.addPhase(db, project.id, { title: "Docs", goal: "Explain it", firstTask: { title: "Write docs", spec: "docs", acceptance: ["ok"], verifyCommands: ["true"] } });
    const phases = () => db.select().from(schema.phases).where(eq(schema.phases.projectId, project.id)).all().sort((x, y) => x.idx - y.idx);
    expect(phases().map((p) => [p.idx, p.title, p.branch])).toEqual([[1, "One", "phase/1-one"], [2, "Two", "phase/2-two"], [3, "Docs", "phase/3-docs"]]);
    expect(task("p3-write-docs")).toBeDefined();

    editor.updatePhase(db, phases()[1]!.id, { title: "Second" });
    expect(phases()[1]!.branch).toBe("phase/2-second");
    editor.deletePhase(db, phases()[1]!.id);
    expect(phases().map((p) => [p.idx, p.title, p.branch])).toEqual([[1, "One", "phase/1-one"], [2, "Docs", "phase/2-docs"]]);
    expect(() => editor.deletePhase(db, phases()[0]!.id)).toThrow(/phase started/); // phase 1 is active
  });

  it("running and finished tasks are locked, with a reason", async () => {
    const { db, task } = await atGate();
    db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.key, "p1-a")).run();
    expect(editor.taskLock(task("p1-a"))).toBe("running");
    expect(() => editor.updateTask(db, task("p1-a").id, { title: "x" })).toThrow(/cannot be edited \(running\)/);
    expect(editor.taskLock(task("p1-b"))).toBeNull();
  });
});

describe("models and reviews per step", () => {
  it("an owner-picked model is used as-is; null hands it back to the profile", async () => {
    const { db, project, task, deps, workerCalls } = await atGate([worker(["a.txt"])], "cost");
    editor.updateTask(db, task("p1-a").id, { model: "opus", effort: "high" });
    expect(task("p1-a")).toMatchObject({ model: "opus", modelSource: "owner" });
    editor.approvePlan(db, project.id);
    await advanceExecution(deps, project.id);
    expect(workerCalls()[0]).toMatchObject({ model: "opus", effort: "high" }); // cost profile would clamp opus to sonnet
    editor.updateTask(db, task("p1-b").id, { model: null });
    expect(task("p1-b")).toMatchObject({ model: null, modelSource: "planner" });
  });

  it("per-task review overrides the profile both ways", async () => {
    // cost profile: no per-task review by default
    const { db, project, task, deps, workerCalls } = await atGate([worker(["a.txt"]), review("approve")], "cost");
    editor.updateTask(db, task("p1-a").id, { review: "always" });
    editor.approvePlan(db, project.id);
    await advanceExecution(deps, project.id);
    expect(workerCalls().map((c) => (c.prompt.includes("master reviewer") ? "review" : "worker"))).toEqual(["worker", "review"]);

    const b = await atGate([worker(["a.txt"])]); // balanced: reviews every task by default
    editor.updateTask(b.db, b.task("p1-a").id, { review: "never" });
    editor.approvePlan(b.db, b.project.id);
    await advanceExecution(b.deps, b.project.id);
    expect(b.workerCalls()).toHaveLength(1);
    expect(b.task("p1-a").status).toBe("done");
  });

  it("role overrides apply to every run of that role and show their source", async () => {
    const { db, project, deps, workerCalls } = await atGate([worker(["a.txt"]), review("approve")]);
    updateProjectSettings(db, project.id, { roleModels: { worker: { model: "haiku", effort: "low" }, reviewer: { model: "opus", effort: "medium" } } });
    let p = getProject(db, project.id);
    expect(effectiveRoles(p)).toMatchObject({ worker: { model: "haiku", source: "project" }, reviewer: { model: "opus", source: "project" }, planner: { source: "profile" } });
    editor.approvePlan(db, project.id);
    await advanceExecution(deps, project.id);
    expect(workerCalls().map((c) => c.model)).toEqual(["haiku", "opus"]);
    p = updateProjectSettings(db, project.id, { roleModels: { worker: null } });
    expect(p.roleModels).toEqual({ reviewer: { model: "opus", effort: "medium" } });
  });
});

describe("plan editor API", () => {
  it("answers edits with the whole plan, 422 problems with pointers, 409 when locked", async () => {
    const { db, deps, config, project, task } = await atGate();
    const server = buildServer({ app: { ...deps, db, config }, webDir: null });
    const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const r = await server.inject({ method, url, payload: payload as object | undefined });
      return { status: r.statusCode, body: r.json() };
    };
    const ok = await call("PATCH", `/api/tasks/${task("p1-a").id}`, { title: "Make a.txt", review: "always" });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(2);
    expect(ok.body[0]).toMatchObject({ idx: 1, editable: true, deletable: false, canAddTasks: true, lockedReason: "phase_started" });
    expect(ok.body[0].tasks[0]).toMatchObject({ key: "p1-a", title: "Make a.txt", review: "always", editable: true, lockedReason: null });

    const bad = await call("PATCH", `/api/tasks/${task("p1-a").id}`, { dependsOn: [task("p2-c").id] });
    expect(bad.status).toBe(422);
    expect(bad.body.problems[0]).toMatchObject({ taskKey: "p1-a", phaseIdx: 1, field: "dependsOn" });

    const detail = await call("GET", "/api/projects/demo");
    expect(detail.body.effectiveRoles.worker).toMatchObject({ source: "profile" });
    expect((await call("PATCH", "/api/projects/demo", { roleModels: { planner: { model: "sonnet", effort: "low" } } })).status).toBe(200);

    expect((await call("POST", "/api/projects/demo/approve-plan")).body.status).toBe("executing");
    db.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.key, "p1-a")).run();
    const locked = await call("DELETE", `/api/tasks/${task("p1-a").id}`);
    expect(locked).toMatchObject({ status: 409, body: { error: "p1-a cannot be deleted (done)" } });
    expect((await call("DELETE", "/api/tasks/nope")).status).toBe(404);
  });
});

import { asc, eq } from "drizzle-orm";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { schema } from "../src/db/index.js";
import { advanceExecution, recoverInFlight, runExecution } from "../src/loops/execution.js";
import { getProject } from "../src/projects/repo.js";
import { answerAndUnblock } from "../src/projects/unblock.js";
import { handoff, review, setup as baseSetup, worker, type Handler } from "./helpers.js";

const setup = (script: Handler[], profile: "balanced" | "cost" = "balanced") => baseSetup(script, { profile });

describe("execution loop", () => {
  it("runs every task and phase to a finished project, merging phases into main", async () => {
    const { db, deps, project, workerCalls, task, git } = await setup([
      worker(["a.txt"]), review("approve"),
      worker(["b.txt"]), review("approve", "consider a README"),
      review("approve"), // phase 1
      worker(["c.txt"]), review("approve"),
      review("approve"), // phase 2
      handoff,
    ]);
    const res = await runExecution(deps, project.id);
    expect(res.message).toMatch(/project complete/);
    expect(getProject(db, project.id).status).toBe("done");

    const calls = workerCalls();
    expect(calls).toHaveLength(9); // 3 workers, 3 task reviews, 2 phase reviews, the handoff
    const first = calls[0]!;
    expect(first.permissionMode).toBe("bypassPermissions");
    expect(first.disallowedTools).toEqual(["Bash(git push:*)"]);
    expect(first.prompt).toContain("Your task: `p1-a`");
    expect(first.prompt).toContain("Remember to add an index on clicks.code"); // plan-review note forwarded
    expect(calls[2]!.prompt).not.toContain("consider a README"); // that note comes from p1-b's review, later
    expect(calls[5]!.prompt).toContain("consider a README");
    expect(calls[1]!.prompt).toContain("+a.txt"); // reviewer sees the diff
    expect(calls[4]!.prompt).toContain("Phase 1: One");

    for (const k of ["p1-a", "p1-b", "p2-c"]) expect(task(k).status).toBe("done");
    expect(db.select().from(schema.phases).orderBy(asc(schema.phases.idx)).all().map((p) => p.status)).toEqual(["done", "done"]);
    // main only moves by phase merges; task commits live on the phase branches.
    const mainLog = (await git("log", "--first-parent", "--format=%s", "main")).split("\n");
    expect(mainLog.slice(0, 3)).toEqual(["merge: phase 2 — Two", "merge: phase 1 — One", "docs: implementation plan"]);
    expect(await git("log", "--format=%s", "phase/2-two")).toContain("task(p2-c): make c.txt");
    expect(await git("branch", "--show-current")).toBe("main");
    for (const f of ["a.txt", "b.txt", "c.txt"]) expect(existsSync(join(project.repoPath, f))).toBe(true);
    // 3 task gates + 2 phase gates (phase 1 re-runs both commands)
    expect(db.select().from(schema.verifications).all()).toHaveLength(3 + 2 + 1);
  });

  it("failed verification → rework in the same session with the gate output", async () => {
    const { deps, project, workerCalls, task } = await setup([worker([], "w1"), worker(["a.txt"], "w1"), review("approve")]);
    expect((await advanceExecution(deps, project.id)).message).toMatch(/verification failed/);
    expect(task("p1-a")).toMatchObject({ status: "rework", attempts: 1 });
    expect(task("p1-a").lastFeedback).toContain("test -f a.txt");

    expect((await advanceExecution(deps, project.id)).message).toMatch(/p1-a done/);
    const retry = workerCalls()[1]!;
    expect(retry.resumeSessionId).toBe("w1");
    expect(retry.prompt).toContain("did not pass yet");
    expect(retry.prompt).toContain("exited with 1");
    expect(task("p1-b").status).toBe("ready");
  });

  it("a limit interrupts the worker without using an attempt; partial work is kept and resumed", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const partial: Handler = (req) => {
      writeFileSync(join(req.cwd, "partial.txt"), "half");
      return { ...FakeClaudeClient.limited(reset), sessionId: "w9" };
    };
    const { deps, project, workerCalls, task, git } = await setup([partial, worker(["a.txt"], "w9"), review("approve")]);
    expect((await advanceExecution(deps, project.id)).status).toBe("interrupted");
    expect(task("p1-a")).toMatchObject({ status: "interrupted", attempts: 0, sessionId: "w9" });

    await advanceExecution(deps, project.id);
    expect(workerCalls()[1]!.resumeSessionId).toBe("w9");
    expect(workerCalls()[1]!.prompt).toContain("interrupted");
    expect(await git("log", "--format=%s")).toContain("wip(p1-a): partial work before resume");
    expect(task("p1-a").status).toBe("done");
  });

  it("an interrupted review resumes as a review, not a new worker run", async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const { deps, project, workerCalls, task } = await setup([worker(["a.txt"]), () => FakeClaudeClient.limited(reset), review("approve")]);
    expect((await advanceExecution(deps, project.id)).status).toBe("interrupted");
    expect(task("p1-a").status).toBe("reviewing");
    await advanceExecution(deps, project.id);
    expect(workerCalls()).toHaveLength(3);
    expect(workerCalls()[2]!.prompt).toContain("master reviewer");
    expect(task("p1-a").status).toBe("done");
  });

  it("restart recovery turns a running task into interrupted", async () => {
    const { db, deps, project, task } = await setup([]);
    db.update(schema.tasks).set({ status: "running" }).where(eq(schema.tasks.key, "p1-a")).run();
    expect(recoverInFlight(deps.db)).toBe(1);
    expect(task("p1-a").status).toBe("interrupted");
  });

  it("exhausted attempts block the project; the owner's answer retries the task with it", async () => {
    const { db, deps, project, workerCalls, task } = await setup([
      worker([], "w"), worker([], "w"), worker([], "w"),
      worker(["a.txt"], "w"), review("approve"),
    ]);
    const res = await runExecution(deps, project.id);
    expect(res.status).toBe("blocked");
    expect(task("p1-a")).toMatchObject({ status: "failed", attempts: 3 });
    expect(getProject(db, project.id).blockedReason).toMatch(/p1-a failed 3×/);

    const p = answerAndUnblock(deps, "demo", "The file must be created in the repo root.");
    expect(p.status).toBe("executing");
    expect(task("p1-a")).toMatchObject({ status: "rework", attempts: 0 });

    await advanceExecution(deps, project.id);
    expect(workerCalls()[3]!.prompt).toContain("The file must be created in the repo root.");
    expect(task("p1-a").status).toBe("done");
  });

  it("phase review rework adds a fix-up task, then the phase is reviewed again", async () => {
    const { db, deps, project, task } = await setup([
      worker(["a.txt"]), review("approve"),
      worker(["b.txt"]), review("approve"),
      review("rework", "Add a LICENSE file"),
      worker(["LICENSE"]), review("approve"),
      review("approve"),
    ]);
    await runExecution(deps, project.id, { maxSteps: 7 });
    const fix = task("p1-fix-1");
    expect(fix).toMatchObject({ status: "done", verifyCommands: ["test -f a.txt", "test -f b.txt"] });
    expect(fix.spec).toContain("Add a LICENSE file");
    expect(db.select().from(schema.phases).where(eq(schema.phases.idx, 1)).get()!.status).toBe("done");
  });

  it("cost profile skips per-task reviews and only reviews whole phases", async () => {
    const { deps, project, workerCalls } = await setup([worker(["a.txt"]), worker(["b.txt"]), review("approve")], "cost");
    await runExecution(deps, project.id, { maxSteps: 4 });
    const kinds = workerCalls().map((c) => (c.prompt.includes("master reviewer") ? "review" : "worker"));
    expect(kinds).toEqual(["worker", "worker", "review"]);
  });

  it("stops after N finished tasks when asked", async () => {
    const { deps, project, task } = await setup([worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve")]);
    await runExecution(deps, project.id, { stopAfterTasksDone: 1 });
    expect(task("p1-a").status).toBe("done");
    expect(task("p1-b").status).toBe("ready");
  });
});

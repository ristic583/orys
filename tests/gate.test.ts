/** Gate tuning: failures that predate the task, the worker's report, phase-only checks, measured timings. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { schema } from "../src/db/index.js";
import { advanceExecution, verifyTiming } from "../src/loops/execution.js";
import { json, review, setup, worker, type Handler } from "./helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const setVerify = (db: Awaited<ReturnType<typeof setup>>["db"], key: string, commands: string[]) =>
  db.update(schema.tasks).set({ verifyCommands: commands }).where(eq(schema.tasks.key, key)).run();

describe("verify gate", () => {
  it("a failure that also happens before the task goes to the reviewer, without using an attempt", async () => {
    const { db, deps, project, workerCalls, task } = await setup([worker(["a.txt"]), review("approve", "missing.txt is still red")]);
    setVerify(db, "p1-a", ["test -d .", "test -f missing.txt"]);

    expect((await advanceExecution(deps, project.id)).message).toMatch(/p1-a done/);
    expect(task("p1-a")).toMatchObject({ status: "done", attempts: 0 });

    const reviewPrompt = workerCalls()[1]!.prompt;
    expect(reviewPrompt).toContain("FAILED, but it fails before this task too");
    expect(reviewPrompt).toContain("`test -f missing.txt` fails after this work");
    // The base commit got the gate up to the failing command, recorded as baseline runs.
    const base = db.select().from(schema.verifications).where(eq(schema.verifications.baseline, true)).all();
    expect(base.map((v) => [v.command, v.exitCode === 0])).toEqual([["test -d .", true], ["test -f missing.txt", false]]);
  });

  it("only the same command failing on the base commit counts; the branch is restored afterwards", async () => {
    const { db, deps, project, task, git } = await setup([worker(["a.txt"]), review("approve")]);
    // Passes before the task (no a.txt yet), fails after: the worker's doing.
    setVerify(db, "p1-a", ["test ! -f a.txt"]);
    expect((await advanceExecution(deps, project.id)).message).toMatch(/verification failed/);
    expect(task("p1-a")).toMatchObject({ status: "rework", attempts: 1 });
    expect(await git("branch", "--show-current")).toBe("phase/1-one");
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("disputed failure + reviewer rework uses an attempt and passes both outputs to the worker", async () => {
    const { db, deps, project, workerCalls, task } = await setup([worker(["a.txt"], "w1"), review("rework", "missing.txt is yours: create it"), worker(["missing.txt"], "w1"), review("approve")]);
    setVerify(db, "p1-a", ["test -f missing.txt"]);
    await advanceExecution(deps, project.id);
    expect(task("p1-a")).toMatchObject({ status: "rework", attempts: 1 });
    expect(task("p1-a").lastFeedback).toContain("missing.txt is yours");
    expect(task("p1-a").lastFeedback).toContain("PRE-EXISTING GATE FAILURE");

    await advanceExecution(deps, project.id);
    expect(workerCalls()[2]!.prompt).toContain("missing.txt is yours");
    expect(task("p1-a").status).toBe("done");
  });

  it("an interrupted disputed review resumes with the gate output, not '(passed earlier)'", async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const { db, deps, project, workerCalls, task } = await setup([worker(["a.txt"]), () => FakeClaudeClient.limited(reset), review("approve")]);
    setVerify(db, "p1-a", ["test -f missing.txt"]);
    expect((await advanceExecution(deps, project.id)).status).toBe("interrupted");
    expect(task("p1-a").status).toBe("reviewing");
    await advanceExecution(deps, project.id);
    expect(workerCalls()[2]!.prompt).toContain("FAILED, but it fails before this task too");
    expect(task("p1-a").status).toBe("done");
  });

  it("the reviewer sees the worker's own report", async () => {
    const noisy: Handler = (req) => {
      writeFileSync(join(req.cwd, "a.txt"), "a\n");
      return FakeClaudeClient.ok(json({ summary: "made a.txt", notes_for_reviewer: "PRE-EXISTING: flaky poll test" }), { sessionId: "w" });
    };
    const { deps, project, workerCalls } = await setup([noisy, review("approve")]);
    await advanceExecution(deps, project.id);
    const p = workerCalls()[1]!.prompt;
    expect(p).toContain("#### Worker's report");
    expect(p).toContain("PRE-EXISTING: flaky poll test");
  });

  it("phase verify commands run only in the phase gate", async () => {
    const { db, deps, project } = await setup([worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve"), review("approve")]);
    const phase1 = db.select().from(schema.phases).where(eq(schema.phases.idx, 1)).get()!;
    db.update(schema.phases).set({ verifyCommands: ["test -f a.txt && test -f b.txt && echo full"] }).where(eq(schema.phases.id, phase1.id)).run();
    for (let i = 0; i < 3; i++) await advanceExecution(deps, project.id); // two tasks, then → phase review
    const full = () => db.select().from(schema.verifications).all().filter((v) => v.command.includes("echo full"));
    expect(full()).toHaveLength(0);
    expect((await advanceExecution(deps, project.id)).message).toMatch(/phase 1 approved/);
    expect(full()).toHaveLength(1);
  });
});

describe("worker prompt", () => {
  it("names verify commands that were slow in this project", async () => {
    const { db, deps, project, workerCalls, task } = await setup([worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve")]);
    const slow = "dotnet test tests/Integration";
    setVerify(db, "p1-b", ["test -f b.txt", slow]);
    db.insert(schema.verifications).values({ taskId: task("p1-a").id, command: slow, exitCode: 0, durationMs: 172_000 }).run();
    expect(verifyTiming(db, project.id, ["test -f b.txt", slow])).toContain("`dotnet test tests/Integration` takes about 3 min");
    expect(verifyTiming(db, project.id, ["test -f b.txt"])).toBe("");

    await advanceExecution(deps, project.id);
    await advanceExecution(deps, project.id).catch(() => undefined);
    const p = workerCalls().find((c) => c.prompt.includes("Your task: `p1-b`"))?.prompt ?? "";
    expect(p).toContain("takes about 3 min");
    expect(p).toContain("once, at the end");
  });

  it("UI screenshots go to .orys/screens: never committed, listed for the reviewer", async () => {
    const shooter: Handler = (req) => {
      writeFileSync(join(req.cwd, "a.txt"), "a\n");
      mkdirSync(join(req.cwd, ".orys", "screens"), { recursive: true });
      writeFileSync(join(req.cwd, ".orys", "screens", "p1-a-375.png"), "png");
      return FakeClaudeClient.ok(json({ summary: "made a.txt" }), { sessionId: "w" });
    };
    const { deps, project, workerCalls, git } = await setup([shooter, review("approve")]);
    await advanceExecution(deps, project.id);
    expect(workerCalls()[0]!.prompt).toContain(".orys/screens/p1-a-375.png");
    expect(workerCalls()[1]!.prompt).toContain("- `.orys/screens/p1-a-375.png`");
    expect(await git("ls-files", ".orys")).toBe("");
    expect(await git("status", "--porcelain")).toBe("");
  });
});

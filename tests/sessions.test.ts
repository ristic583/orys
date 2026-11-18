import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { schema } from "../src/db/index.js";
import { advanceExecution, runExecution } from "../src/loops/execution.js";
import { runPlanningToCompletion } from "../src/loops/planning.js";
import { BriefSchema } from "../src/projects/brief.js";
import { approvePlan } from "../src/projects/planEditor.js";
import { createProjectFromBrief, getProject } from "../src/projects/repo.js";
import { buildServer } from "../src/server/index.js";
import { claimSlot, listSlots, slotOf } from "../src/sessions/slots.js";
import { architect, handoff, planner, PLAN, review, setup, worker, type Handler } from "./helpers.js";

const big = (h: Handler): Handler => async (req) => ({ ...(await h(req)), contextTokens: 200_000 });

/** A scratch project with its session, planned and approved. */
async function withSlot(script: Handler[]) {
  const ctx = await setup([architect, review("approve"), planner(PLAN), review("approve"), ...script], { planned: false });
  await runPlanningToCompletion(ctx.deps, ctx.project.id);
  approvePlan(ctx.db, ctx.project.id);
  // Calls after the four planning calls (architect, review, planner, review).
  return { ...ctx, workerCalls: () => ctx.claude.calls.slice(4) };
}

describe("project session", () => {
  it("builders continue one chain; reviewers stay independent", async () => {
    const { db, claude, project } = await withSlot([]);
    const [arch, archReview, plan, planReview] = claude.calls;
    expect(arch!.resumeSessionId).toBeUndefined(); // the first builder run starts the session
    expect(plan!.resumeSessionId).toBe("arch"); // the planner continues the architect's session
    expect(archReview!.resumeSessionId).toBeUndefined();
    expect(planReview!.resumeSessionId).toBeUndefined();
    expect(slotOf(db, project.id)).toMatchObject({ sessionId: "plan", runs: 2 });
  });

  it("workers continue the project session from task to task", async () => {
    const { db, deps, project, workerCalls } = await withSlot([worker(["a.txt"], "w1"), review("approve"), worker(["b.txt"], "w2"), review("approve")]);
    await advanceExecution(deps, project.id);
    await advanceExecution(deps, project.id);
    const [first, , second] = workerCalls();
    expect(first!.resumeSessionId).toBe("plan");
    expect(first!.prompt).toContain("Your task: `p1-a`"); // a new task gets the full prompt, in the same session
    expect(second!.resumeSessionId).toBe("w1");
    expect(slotOf(db, project.id)).toMatchObject({ sessionId: "w2", runs: 4 });
  });

  it("a session past the context limit is replaced at the start of the next step", async () => {
    const { db, deps, project, workerCalls } = await withSlot([big(worker([], "w-big")), worker(["a.txt"], "w-new"), review("approve")]);
    await advanceExecution(deps, project.id); // gate fails → rework; the session is now too large
    expect(slotOf(db, project.id)).toMatchObject({ sessionId: "w-big", contextTokens: 200_000 });
    await advanceExecution(deps, project.id);
    const retry = workerCalls()[1]!;
    expect(retry.resumeSessionId).toBeUndefined(); // fresh session…
    expect(retry.prompt).toContain("Your task: `p1-a`"); // …so the full task prompt, not "fix the previous attempt" alone
    expect(retry.prompt).toContain("Problems from the previous attempt"); // the gate output is still included
    expect(slotOf(db, project.id)).toMatchObject({ sessionId: "w-new", rotations: 1 });
    const rotated = db.select().from(schema.events).all().find((e) => e.type === "session_rotated");
    expect(rotated?.payload).toMatchObject({ reason: "too_large", previous: "w-big", contextTokens: 200_000 });
  });

  it("a session that cannot be resumed is dropped and the next run starts fresh", async () => {
    const gone: Handler = () => ({ exitCode: 1, errorKind: "crash", stderrTail: "No conversation found with session ID: plan" });
    const { db, deps, project, workerCalls } = await withSlot([gone, worker(["a.txt"], "w-fresh"), review("approve")]);
    await advanceExecution(deps, project.id);
    expect(slotOf(db, project.id)?.sessionId).toBeNull();
    await advanceExecution(deps, project.id);
    expect(workerCalls()[1]!.resumeSessionId).toBeUndefined();
    expect(slotOf(db, project.id)?.sessionId).toBe("w-fresh");
  });

  it("the slot is released when the project is done", async () => {
    const { db, deps, project } = await withSlot([
      worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve"), review("approve"),
      worker(["c.txt"]), review("approve"), review("approve"), handoff,
    ]);
    await runExecution(deps, project.id);
    expect(getProject(db, project.id).status).toBe("done");
    expect(slotOf(db, project.id)).toBeUndefined();
    const released = db.select().from(schema.events).all().find((e) => e.type === "session_released");
    expect(released?.payload).toMatchObject({ reason: "done", slot: 1 });
  });
});

describe("sessions", () => {
  it("every project gets its own session the first time a builder runs; there is no pool to run out of", async () => {
    const { db, config } = await setup([], { planned: false });
    const brief = (slug: string) => BriefSchema.parse({ slug, name: slug, problem: "Something to build." });
    const opts = { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" as const, claimSessionSlot: true };
    const projects = await Promise.all(["alpha", "beta", "gamma", "delta", "epsilon"].map((s) => createProjectFromBrief(db, brief(s), opts)));
    expect(projects.map((p) => slotOf(db, p.id)?.idx)).toEqual([1, 2, 3, 4, 5]);
    expect(db.select().from(schema.events).all().some((e) => e.type === "session_slot_unavailable")).toBe(false);
    expect(claimSlot(db, projects[0]!).idx).toBe(1); // idempotent
  });

  it("API: list, reset with a resume command; claim/release/add/remove are gone", async () => {
    const { db, deps, config, project } = await setup([architect], { planned: false });
    const server = buildServer({ app: { ...deps, db, config }, webDir: null });
    const call = async (method: "GET" | "POST" | "DELETE", url: string) => {
      const r = await server.inject({ method, url });
      return { status: r.statusCode, body: r.json() };
    };
    await runPlanningToCompletion(deps, project.id).catch(() => undefined); // architect runs (creating the session), then the script runs out
    const view = (await call("GET", "/api/sessions")).body;
    expect(view.maxContext).toBe(config.AIPM_SESSION_MAX_CONTEXT);
    expect(view.slots[0]).toMatchObject({ projectSlug: "demo", sessionId: "arch", busy: false });
    expect(view.slots[0].resumeCommand).toBe(`cd '${project.repoPath}' && claude --resume arch`);
    expect((await call("GET", "/api/projects/demo")).body.session).toMatchObject({ idx: 1, sessionId: "arch" });

    expect((await call("POST", "/api/projects/demo/session/reset")).body).toMatchObject({ sessionId: null, rotations: 1 });
    expect((await call("POST", "/api/projects/demo/session/release")).status).toBe(400);
    expect((await call("POST", "/api/sessions")).status).toBe(404);
    expect(listSlots(db)).toHaveLength(1);
  });
});

void FakeClaudeClient;

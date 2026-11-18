import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { FakeClaudeClient, type ClaudeRequest } from "../src/claude/client.js";
import { schema } from "../src/db/index.js";
import type { StreamLine } from "../src/claude/client.js";
import { BriefSchema } from "../src/projects/brief.js";
import { applyProjectEvent, createProject, getProject } from "../src/projects/repo.js";
import { updateProjectSettings } from "../src/projects/settings.js";
import { loadLimit } from "../src/runs/limitStore.js";
import { PROBE_PROMPT } from "../src/scheduler/probe.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { rankCandidates, urgency, weight, type Candidate } from "../src/scheduler/score.js";
import { architect, handoff, PLAN, planner, review, setup, worker, type Handler } from "./helpers.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const H = 3_600_000;
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, slug: id, priority: 3, deadline: null, tokens: 0, lastRunAt: null, createdAt: new Date(0), ...over,
});

describe("rankCandidates (fair share)", () => {
  it("weights and urgency", () => {
    expect([weight(1), weight(3), weight(5)]).toEqual([1, 4, 16]);
    expect(urgency(null, NOW)).toBe(1);
    expect(urgency(new Date(NOW.getTime() + 30 * 24 * H), NOW)).toBe(1);
    expect(urgency(new Date(NOW.getTime() + 7 * 24 * H), NOW)).toBeCloseTo(2.5);
    expect(urgency(new Date(NOW.getTime() - 24 * H), NOW)).toBe(4);
  });

  it("equal priority: the project that used less of the window goes first", () => {
    const r = rankCandidates([cand("heavy", { tokens: 900 }), cand("light", { tokens: 100 })], NOW);
    expect(r.map((c) => c.id)).toEqual(["light", "heavy"]);
  });

  it("priority outweighs usage share", () => {
    const r = rankCandidates([cand("p2", { priority: 2 }), cand("p4", { priority: 4, tokens: 1_000 })], NOW);
    expect(r[0]!.id).toBe("p4");
  });

  it("a deadline raises urgency", () => {
    const r = rankCandidates([cand("a"), cand("b", { deadline: new Date(NOW.getTime() + 2 * 24 * H) })], NOW);
    expect(r[0]!.id).toBe("b");
  });

  it("cache locality keeps the warm project, unless another one has a deadline within 48h", () => {
    const warm = cand("warm", { tokens: 600, lastRunAt: new Date(NOW.getTime() - 10 * 60_000) });
    const cold = cand("cold", { tokens: 400 });
    expect(rankCandidates([warm, cold], NOW)[0]).toMatchObject({ id: "warm", locality: true });
    expect(rankCandidates([{ ...warm, lastRunAt: new Date(NOW.getTime() - H) }, cold], NOW)[0]!.id).toBe("cold");
    const urgent = { ...cold, deadline: new Date(NOW.getTime() + 24 * H) };
    expect(rankCandidates([warm, urgent], NOW)[0]).toMatchObject({ id: "cold" });
    expect(rankCandidates([warm, urgent], NOW).find((c) => c.id === "warm")!.locality).toBe(false);
  });
});

/** A controllable clock for the scheduler. */
function clock(start = new Date()) {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms), set: (d: Date) => void (t = d.getTime()) };
}

/** A worker call that announces its session and then runs until aborted (or forever). */
const hang = (sessionId: string): Handler => (req: ClaudeRequest) => {
  req.onLine?.({ type: "system", subtype: "init", session_id: sessionId } as StreamLine);
  return new Promise((resolve) =>
    req.signal?.addEventListener("abort", () => resolve({ aborted: true, exitCode: 143, sessionId }), { once: true }),
  );
};
const probeOk: Handler = (req) => {
  expect(req.prompt).toBe(PROBE_PROMPT);
  expect(req.model).toBe("haiku");
  return FakeClaudeClient.ok("OK", { rateLimit: { status: "allowed", resetsAt: sec(new Date()) + 5 * 3600, rateLimitType: "five_hour" } });
};

describe("scheduler", () => {
  it("runs the highest-scoring project first and skips paused ones", async () => {
    const { db, deps, config, claude } = await setup([architect, architect], { planned: false });
    const make = (slug: string, priority: number, paused = false) => {
      const brief = BriefSchema.parse({ slug, name: slug, problem: "Something to build.", priority });
      const p = applyProjectEvent(db, createProject(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" }), { type: "start" });
      if (paused) db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, p.id)).run();
      return p;
    };
    const urgent = make("urgent", 5);
    make("napping", 5, true);
    const s = new Scheduler(deps);
    expect(s.rank().map((c) => c.slug)).toEqual(["urgent", "demo"]);
    const r = await s.tick();
    expect(r).toMatchObject({ kind: "ran", slug: "urgent" });
    expect(claude.calls[0]!.cwd).toBe(urgent.repoPath);
  });

  it("is idle when nothing can run", async () => {
    const { db, deps, project } = await setup([], { planned: false });
    db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id)).run();
    expect(await new Scheduler(deps).tick()).toEqual({ kind: "idle" });
  });

  it("limit: interrupts, waits until reset, probes, then resumes the same session", async () => {
    const c = clock();
    const reset1 = new Date((sec(c.now()) + 7_200) * 1000);
    const reset2 = new Date((sec(c.now()) + 10_800) * 1000);
    const { deps, task, workerCalls, claude } = await setup([
      (req) => ({ ...FakeClaudeClient.limited(sec(reset1)), sessionId: "w1", result: undefined, lastRateLimit: { status: "rejected", resetsAt: sec(reset1), rateLimitType: "five_hour" } }),
      () => FakeClaudeClient.limited(sec(reset2)), // first probe: still limited, new reset time
      probeOk,
      worker(["a.txt"], "w1"),
      review("approve"),
    ]);
    const s = new Scheduler(deps, { now: c.now });

    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "interrupted" } });
    expect(task("p1-a")).toMatchObject({ status: "interrupted", attempts: 0, sessionId: "w1" });
    expect(loadLimit(deps.db)).toMatchObject({ status: "limited", resetAt: reset1 });

    // Before the reset: no claude call at all.
    c.advance(H);
    const calls = claude.calls.length;
    expect(await s.tick()).toMatchObject({ kind: "waiting", until: reset1 });
    expect(claude.calls.length).toBe(calls);

    // Reset passed, but the probe says we are still limited.
    c.set(new Date(reset1.getTime() + 1_000));
    expect(await s.tick()).toMatchObject({ kind: "probed", ok: false, until: reset2 });
    expect(await s.tick()).toMatchObject({ kind: "waiting", until: reset2 });

    c.set(new Date(reset2.getTime() + 1_000));
    expect(await s.tick()).toMatchObject({ kind: "probed", ok: true });
    expect(loadLimit(deps.db).status).toBe("ok");

    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "progressed" } });
    const resumed = workerCalls().at(-2)!;
    expect(resumed.resumeSessionId).toBe("w1");
    expect(resumed.prompt).toContain("interrupted");
    expect(task("p1-a").status).toBe("done");
  });

  it("does not probe more often than the probe interval", async () => {
    const c = clock();
    const reset = new Date(c.now().getTime() + H);
    const { deps, claude } = await setup([() => FakeClaudeClient.limited(sec(reset)), () => FakeClaudeClient.limited(sec(reset) - 10)]);
    const s = new Scheduler(deps, { now: c.now, probeIntervalMs: 120_000 });
    await s.tick();
    c.set(new Date(reset.getTime() + 1_000));
    // The second probe returns a reset time already in the past → fallback (+30 min) keeps us waiting.
    expect(await s.tick()).toMatchObject({ kind: "probed", ok: false });
    const n = claude.calls.length;
    expect(await s.tick()).toMatchObject({ kind: "waiting" });
    expect(claude.calls.length).toBe(n);
  });

  it("auth error pauses everything until a later probe succeeds", async () => {
    const c = clock();
    const authFail: Handler = () => ({
      exitCode: 1,
      errorKind: "auth",
      result: { type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: "x", num_turns: 0, duration_ms: 0, total_cost_usd: 0 },
    });
    const { deps, task } = await setup([authFail, probeOk, worker(["a.txt"]), review("approve")]);
    const s = new Scheduler(deps, { now: c.now, authProbeIntervalMs: 5 * 60_000 });
    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "interrupted" } });
    expect(await s.tick()).toMatchObject({ kind: "waiting", reason: expect.stringMatching(/auth login/) });
    c.advance(6 * 60_000);
    expect(await s.tick()).toMatchObject({ kind: "probed", ok: true });
    expect(loadLimit(deps.db).authError).toBeNull();
    await s.tick();
    expect(task("p1-a").status).toBe("done");
  });

  it("graceful stop aborts the running worker; the task is interrupted and resumable", async () => {
    const { deps, task, workerCalls } = await setup([hang("w7")]);
    const s = new Scheduler(deps);
    const running = s.tick();
    await vi.waitFor(() => expect(workerCalls()).toHaveLength(1));
    expect(s.current).toMatchObject({ slug: "demo", stage: "execution" });
    s.stop();
    expect(await running).toMatchObject({ kind: "ran", step: { status: "interrupted" } });
    expect(task("p1-a")).toMatchObject({ status: "interrupted", sessionId: "w7", attempts: 0 });
    expect(await s.tick()).toEqual({ kind: "stopped" });
  });

  it("after a hard kill, a new scheduler recovers the task and resumes its session", async () => {
    const { db, deps, task, workerCalls, claude } = await setup([hang("w8")]);
    void new Scheduler(deps).tick(); // never finishes: the process "dies" here
    await vi.waitFor(() => expect(workerCalls()).toHaveLength(1));
    expect(task("p1-a").status).toBe("running");

    claude.enqueue(worker(["a.txt"], "w8"), review("approve"));
    const s2 = new Scheduler(deps);
    expect(s2.recover()).toBe(1);
    expect(task("p1-a")).toMatchObject({ status: "interrupted", sessionId: "w8", attempts: 0 });
    expect(db.select().from(schema.runs).all().every((r) => r.endedAt !== null)).toBe(true);

    await s2.tick();
    expect(workerCalls()[1]!.resumeSessionId).toBe("w8");
    expect(task("p1-a").status).toBe("done");
  });

  it("blocks a project after repeated unexpected errors", async () => {
    const boom: Handler = () => {
      throw new Error("spawn claude ENOENT");
    };
    const { db, deps, project } = await setup([boom, boom, boom], { planned: false });
    const s = new Scheduler(deps, { maxConsecutiveErrors: 3 });
    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "failed" } });
    await s.tick();
    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "blocked" } });
    expect(getProject(db, project.id)).toMatchObject({ status: "blocked", blockedReason: expect.stringMatching(/ENOENT/) });
    expect(await s.tick()).toEqual({ kind: "idle" });
  });

  it("run(untilIdle) drives a project from start to done", async () => {
    const { db, deps, project } = await setup(
      [
        worker(["a.txt"]), review("approve"),
        worker(["b.txt"]), review("approve"),
        review("approve"),
        worker(["c.txt"]), review("approve"),
        review("approve"),
        handoff,
      ],
    );
    const ticks: string[] = [];
    await new Scheduler(deps, { tickMs: 1 }).run({ untilIdle: true, onTick: (r) => ticks.push(r.kind) });
    expect(getProject(db, project.id).status).toBe("done");
    expect(ticks.at(-1)).toBe("idle");
  });

  it("projects run in parallel: a hanging worker in one project does not hold up another", async () => {
    const { db, deps, config, claude, task } = await setup([]);
    const brief = BriefSchema.parse({ slug: "beta", name: "Beta", problem: "Something else to build.", priority: 1 });
    const beta = applyProjectEvent(db, createProject(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" }), { type: "start" });
    // One shared fake: route each call to its project's own script.
    const scripts = new Map<string, Handler[]>([
      ["demo", [hang("w1")]],
      ["beta", [architect, review("approve"), planner(PLAN), review("approve")]],
    ]);
    const router: Handler = (req) => scripts.get(req.cwd.endsWith("beta") ? "beta" : "demo")!.shift()!(req);
    claude.enqueue(...Array.from({ length: 5 }, () => router));

    const s = new Scheduler(deps, { tickMs: 5 });
    const running = s.run();
    await vi.waitFor(() => expect(getProject(db, beta.id).status).toBe("awaiting_owner"), { timeout: 5_000 });
    expect(task("p1-a").status).toBe("running"); // demo's worker is still busy
    expect(s.busy(getProject(db, "demo").id)).toBe(true);
    s.stop();
    await running;
    expect(task("p1-a")).toMatchObject({ status: "interrupted", attempts: 0 });
  });

  it("pausing a project aborts its running claude call right away, without using an attempt", async () => {
    const { db, deps, project, task, workerCalls } = await setup([hang("w2")]);
    const s = new Scheduler(deps, { tickMs: 5, pauseCheckMs: 10 });
    const running = s.run();
    await vi.waitFor(() => expect(workerCalls()).toHaveLength(1));
    updateProjectSettings(db, project.id, { paused: true }); // e.g. `orys pause` from another process
    await vi.waitFor(() => expect(task("p1-a").status).toBe("interrupted"), { timeout: 2_000 });
    expect(task("p1-a")).toMatchObject({ attempts: 0, sessionId: "w2" });
    expect(s.busy(project.id)).toBe(false);
    s.stop();
    await running;
  });
});

/** Level 2: scope → process, the outcome card, design directions, handoff with accept / send back. */
import { asc, eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { chooseProcess, estimate, OutcomeSchema, outcomeWarnings } from "../src/core/outcome.js";
import { PROFILES } from "../src/core/profiles.js";
import { schema } from "../src/db/index.js";
import { runExecution } from "../src/loops/execution.js";
import { runPlanningToCompletion } from "../src/loops/planning.js";
import { approvePlan } from "../src/projects/planEditor.js";
import { acceptHandoff, chooseDesign, outcomeView, ownerMetrics, returnHandoff, setAnswers } from "../src/projects/outcome.js";
import { getProject } from "../src/projects/repo.js";
import { buildServer } from "../src/server/index.js";
import { architect, handoff, json, OUTCOME, PLAN, planner, review, setup, worker, type Handler } from "./helpers.js";

const QUICK = { ...PLAN, scope: { size: "S", risk: "low", ui: false, reason: "Three tiny files." } } as const;
const DESIGN = { ...PLAN, scope: { size: "M", risk: "low", ui: true, design_directions: true, reason: "A new screen whose look is open." } } as const;

const designer: Handler = (req) => {
  const dir = join(req.cwd, "docs", "designs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calm.html"), "<h1>calm</h1>");
  writeFileSync(join(dir, "dense.html"), "<h1>dense</h1>");
  return FakeClaudeClient.ok(json({ directions: [
    { id: "calm", title: "Calm", idea: "One big status, details below", file: "calm.html" },
    { id: "dense", title: "Dense", idea: "Everything in one table", file: "dense.html" },
  ] }), { sessionId: "design" });
};

describe("scope → process", () => {
  it("small and safe → quick; big or risky → full; else standard", () => {
    const p = PROFILES.balanced;
    const s = (size: "XS" | "S" | "M" | "L" | "XL", risk: "low" | "medium" | "high", ui = false) => ({ size, risk, ui, design_directions: true, reason: "r" });
    expect(chooseProcess(s("S", "low"), p)).toMatchObject({ mode: "quick", maxPhases: 1, planReview: false, reviewPerTask: false, maxAttempts: 2 });
    expect(chooseProcess(s("M", "low"), p)).toMatchObject({ mode: "standard", maxPhases: 3, planReview: true });
    expect(chooseProcess(s("S", "high"), p)).toMatchObject({ mode: "full", reviewPerTask: true });
    expect(chooseProcess(s("XL", "low"), p).mode).toBe("full");
    expect(chooseProcess(s("M", "low"), p).reviewPerTask).toBe(false); // task reviews only where the risk warrants them
    expect(chooseProcess(s("M", "medium"), p).reviewPerTask).toBe(true);
    expect(chooseProcess(s("M", "medium"), PROFILES.cost).reviewPerTask).toBe(false);
    expect(chooseProcess(s("M", "low", true), p).designDirections).toBe(true);
    expect(chooseProcess(s("M", "low", false), p).designDirections).toBe(false); // no UI, no mockups
  });

  it("a quick job: one phase, no plan review, no task reviews, one review at the end", async () => {
    const { db, deps, claude, project } = await setup([architect, review("approve"), planner(QUICK)], { planned: false });
    await runPlanningToCompletion(deps, project.id);
    const p = getProject(db, project.id);
    expect(p).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    expect(p.process).toMatchObject({ mode: "quick" });
    expect(claude.calls).toHaveLength(3); // architect, its review, planner — no plan review
    const phases = db.select().from(schema.phases).all();
    expect(phases).toHaveLength(1); // the planner's two phases merged
    expect(db.select().from(schema.tasks).all().map((t) => [t.key, t.maxAttempts])).toEqual([["p1-a", 2], ["p1-b", 2], ["p2-c", 2]]);

    approvePlan(db, project.id);
    claude.enqueue(worker(["a.txt"]), worker(["b.txt"]), worker(["c.txt"]), review("approve"), handoff);
    expect((await runExecution(deps, project.id)).message).toMatch(/complete/);
    const kinds = db.select().from(schema.runs).orderBy(asc(schema.runs.id)).all().map((r) => r.kind).slice(3);
    expect(kinds).toEqual(["worker", "worker", "worker", "master_review", "handoff"]);
  });
});

describe("outcome card", () => {
  it("schema: an empty 'you will see' must say visible_change none", () => {
    expect(OutcomeSchema.safeParse({ ...OUTCOME, you_will_see: [], visible_change: "little" }).success).toBe(false);
    expect(OutcomeSchema.safeParse({ ...OUTCOME, you_will_see: [], visible_change: "none" }).success).toBe(true);
  });

  it("warnings: little to see in a project with screens, a vague goal", () => {
    const o = OutcomeSchema.parse({ ...OUTCOME, visible_change: "little", to_see_it: ["Deploy the agent to the server"] });
    expect(outcomeWarnings(o, { hasUi: true, goals: ["Modern design"] }).map((w) => w.code)).toEqual(["little_visible_change_with_ui", "vague_goal"]);
    expect(outcomeWarnings({ ...o, to_see_it: [] }, { hasUi: false, goals: ["Show network speed per host"] })).toEqual([]);
  });

  it("estimate: minutes by size, one review per phase, limit pauses when the quota is nearly used", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    const e = estimate(Array.from({ length: 6 }, () => ({ size: "S" as const })), 1, { now });
    expect(e.agentMinutes).toBe(50);
    expect(e.limitPauses).toBe(0);
    expect(estimate(Array.from({ length: 6 }, () => ({ size: "S" as const })), 1, { now, utilization: 0.9 }).limitPauses).toBe(1);
    expect(estimate([{ size: "S" }], 1, { now, minutesBySize: { S: 20 } }).agentMinutes).toBe(22);
  });

  it("is stored with the plan; the owner's answers reach the workers", async () => {
    const { db, deps, project, workerCalls } = await setup([worker(["a.txt"]), review("approve")], { approve: false });
    const view = outcomeView(db, project.id);
    expect(view.outcome?.summary_plain).toContain("three text files");
    expect(view.phases[0]).toMatchObject({ goalPlain: "You can open a.txt and b.txt", visible: true });
    expect(view.estimate?.agentMinutes).toBeGreaterThan(0);
    setAnswers(db, project.id, { "Should the files be empty?": "Yes, empty" });
    approvePlan(db, project.id);
    await runExecution(deps, project.id, { stopAfterTasksDone: 1 });
    expect(workerCalls()[0]!.prompt).toContain("Should the files be empty? → **Yes, empty** (the owner's answer)");
  });
});

describe("design directions", () => {
  it("UI work with an open look: mockups before approval; the owner must pick one; workers follow it", async () => {
    const { db, deps, claude, project } = await setup([architect, review("approve"), planner(DESIGN), review("approve"), designer], { planned: false });
    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    expect(outcomeView(db, project.id).designs?.directions.map((d) => d.id)).toEqual(["calm", "dense"]);
    expect(claude.calls[4]!.prompt).toContain("2–3 design directions");

    expect(() => approvePlan(db, project.id)).toThrow(/pick a design direction/);
    chooseDesign(db, project.id, { id: "dense", note: "But bigger numbers" });
    approvePlan(db, project.id);

    claude.enqueue(worker(["a.txt"]), review("approve"));
    await runExecution(deps, project.id, { stopAfterTasksDone: 1 });
    const w = claude.calls[5]!.prompt;
    expect(w).toContain("docs/designs/dense.html");
    expect(w).toContain("But bigger numbers");
  });
});

describe("handoff", () => {
  const FULL = [worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve"), review("approve"), worker(["c.txt"]), review("approve"), review("approve")];

  it("the result is handed over with promises checked; accept counts as accepted the first time", async () => {
    const { db, deps, project, workerCalls } = await setup([...FULL, handoff]);
    await runExecution(deps, project.id);
    const p = getProject(db, project.id);
    expect(p.status).toBe("done");
    expect(p.handoff).toMatchObject({ summary_plain: "The three files are there, in order.", delivered: [{ status: "done" }] });
    expect(workerCalls().at(-1)!.prompt).toContain("Repository root: Files a.txt, b.txt and c.txt"); // the promise to check
    // It cannot run anything itself: it gets what the gate ran, so it does not tell the owner tests "were not run".
    expect(workerCalls().at(-1)!.prompt).toMatch(/`test -f c\.txt` — ran \d+×, passed \d+×; last run \(task p2-c\): passed/);
    acceptHandoff(db, project.id);
    expect(ownerMetrics(db)).toMatchObject({ acceptedFirstTime: 1, acceptedFirstTimeRate: 1, promiseAccuracy: 1 });
  });

  it("send back: a feedback phase runs, then a new handoff; it no longer counts as first-time accepted", async () => {
    const { db, deps, project, workerCalls, claude } = await setup([...FULL, handoff]);
    await runExecution(deps, project.id);
    expect(() => returnHandoff(db, project.id, "no")).toThrow(/say what is wrong/);
    const p = returnHandoff(db, project.id, "c.txt must say hello");
    expect(p).toMatchObject({ status: "executing", returns: 1, accepted: false, handoff: null });
    const feedback = db.select().from(schema.tasks).where(eq(schema.tasks.key, "p3-feedback")).get()!;
    expect(feedback).toMatchObject({ status: "ready", verifyCommands: ["test -f c.txt"] });

    claude.enqueue(worker(["c.txt"]), review("approve"), review("approve"), handoff);
    await runExecution(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "done", returns: 1 });
    expect(workerCalls().find((c) => c.prompt.includes("p3-feedback"))!.prompt).toContain("c.txt must say hello");
    expect(workerCalls().at(-1)!.prompt).toContain("c.txt must say hello"); // the new handoff checks the note too
    acceptHandoff(db, project.id);
    expect(ownerMetrics(db)).toMatchObject({ judged: 1, acceptedFirstTime: 0, acceptedFirstTimeRate: 0 });
  });

  it("API: outcome, answers, design choice, accept / return, metrics", async () => {
    const { db, deps, config, project } = await setup([...FULL, handoff], { approve: false });
    const server = buildServer({ app: { ...deps, db, config }, webDir: null });
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const r = await server.inject({ method, url, payload: payload as object });
      return { status: r.statusCode, body: r.json() };
    };
    expect((await call("GET", "/api/projects/demo/outcome")).body).toMatchObject({ process: { mode: "standard" }, answers: [{ byOwner: false }] });
    expect((await call("POST", "/api/projects/demo/outcome/answers", { answers: { "Should the files be empty?": "Yes" } })).body.answers[0]).toMatchObject({ answer: "Yes", byOwner: true });
    expect((await call("POST", "/api/projects/demo/design-choice", { id: "nope" })).status).toBe(409);
    approvePlan(db, project.id);
    await runExecution(deps, project.id);
    expect((await call("POST", "/api/projects/demo/handoff/accept")).body.accepted).toBe(true);
    expect((await call("GET", "/api/metrics")).body).toMatchObject({ acceptedFirstTime: 1 });
  });
});

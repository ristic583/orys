import { execa } from "execa";
import { asc, eq } from "drizzle-orm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient, type ClaudeRequest } from "../src/claude/client.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import type { LoopDeps } from "../src/loops/common.js";
import { advancePlanning, runPlanningToCompletion } from "../src/loops/planning.js";
import type { PlanInput as Plan } from "../src/loops/plan.js";
import { OUTCOME, SCOPE } from "./helpers.js";
import { BriefSchema } from "../src/projects/brief.js";
import { applyProjectEvent, createProject, getProject } from "../src/projects/repo.js";
import { answerAndUnblock } from "../src/projects/unblock.js";
import { LocalRunner } from "../src/runner/local.js";
import { loadLimit } from "../src/runs/limitStore.js";

type Handler = ConstructorParameters<typeof FakeClaudeClient>[0][number];

const tmp = () => mkdtempSync(join(tmpdir(), "aipm-plan-"));
const json = (v: unknown) => `Done.\n<<<JSON\n${JSON.stringify(v, null, 2)}\nJSON>>>`;

const architect = (sessionId = "arch-1", doc = "# Architecture\n\nTypeScript + SQLite."): Handler => (req) => {
  mkdirSync(join(req.cwd, "docs"), { recursive: true });
  writeFileSync(join(req.cwd, "docs", "ARCHITECTURE.md"), doc);
  return FakeClaudeClient.ok(json({ stack: ["TypeScript"], verify_commands: ["pnpm test"], open_questions: [] }), { sessionId });
};
const review = (decision: "approve" | "rework" | "escalate", feedback = ""): Handler => () =>
  FakeClaudeClient.ok(json({ decision, rationale: `reviewer says ${decision}`, feedback }), { sessionId: "rev" });
const planner = (plan: unknown, sessionId = "plan-1"): Handler => () => FakeClaudeClient.ok(json(plan), { sessionId });

const PLAN: Plan = {
  scope: SCOPE,
  outcome: OUTCOME,
  phases: [
    {
      title: "Project skeleton",
      goal: "Builds and tests run",
      goal_plain: "Nothing to see yet: the project builds",
      tasks: [
        { key: "p1-setup", title: "Init", spec: "Create package.json", acceptance: ["pnpm test passes"], verify_commands: ["pnpm install", "pnpm test"], depends_on: [], model: "haiku", effort: "low" },
        { key: "p1-db", title: "DB", spec: "SQLite schema", acceptance: ["migrations run"], verify_commands: ["pnpm test"], depends_on: ["p1-setup"], model: "opus", effort: "high", feature: "Shorten links" },
      ],
    },
    {
      title: "API",
      goal: "Endpoints",
      goal_plain: "You can create a short link",
      tasks: [{ key: "p2-api", title: "Create endpoint", spec: "POST /links", acceptance: ["returns 201"], verify_commands: ["pnpm test"], depends_on: ["p1-db"] }],
    },
  ],
};

function setup(script: Handler[], profile: "balanced" | "cost" = "balanced") {
  const dir = tmp();
  const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects") });
  const db = openDb(":memory:");
  const claude = new FakeClaudeClient(script);
  const deps: LoopDeps = { db, runner: new LocalRunner(claude), config };
  const brief = BriefSchema.parse({
    slug: "links",
    name: "Links",
    problem: "A tiny URL shortener for personal use.",
    profile,
    features: [{ title: "Shorten links", priority: 5 }],
  });
  let project = createProject(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" });
  project = applyProjectEvent(db, project, { type: "start" });
  return { db, claude, deps, project };
}

const isReview = (r: ClaudeRequest) => r.prompt.includes("master reviewer");

describe("planning pipeline", () => {
  it("happy path: architecture → plan → tasks in the database", async () => {
    const { db, claude, deps, project } = setup([architect(), review("approve"), planner(PLAN), review("approve")]);
    const res = await runPlanningToCompletion(deps, project.id);

    expect(res.status).toBe("progressed");
    const p = getProject(db, project.id);
    expect(p).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" }); // the owner approves before anything runs

    // Calls: architect writes, planner and reviewers are read-only.
    expect(claude.calls).toHaveLength(4);
    expect(claude.calls[0]!.permissionMode).toBe("bypassPermissions");
    expect(claude.calls[0]!.model).toBe("opus");
    expect(claude.calls[0]!.prompt).toContain("A tiny URL shortener");
    expect(claude.calls[1]!.disallowedTools).toContain("Edit");
    expect(claude.calls[1]!.prompt).toContain("TypeScript + SQLite");
    expect(claude.calls[2]!.disallowedTools).toContain("Write");
    expect(claude.calls[2]!.prompt).toContain("TypeScript + SQLite");
    expect(claude.calls[3]!.prompt).toContain("p1-setup");

    // Plan persisted.
    const phases = db.select().from(schema.phases).orderBy(asc(schema.phases.idx)).all();
    expect(phases.map((x) => [x.idx, x.status, x.branch])).toEqual([
      [1, "active", "phase/1-project-skeleton"],
      [2, "pending", "phase/2-api"],
    ]);
    const tasks = db.select().from(schema.tasks).all();
    const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
    expect(byKey["p1-setup"]).toMatchObject({ status: "ready", model: "haiku", effort: "low", maxAttempts: 3 });
    expect(byKey["p1-db"]).toMatchObject({ status: "pending", model: "opus", effort: "high", dependsOn: [byKey["p1-setup"]!.id] });
    expect(byKey["p1-db"]!.featureId).toBeTruthy();
    expect(byKey["p2-api"]).toMatchObject({ status: "pending", dependsOn: [byKey["p1-db"]!.id], model: "sonnet", effort: "medium" });

    // Repo: docs committed on main, clean tree.
    for (const f of ["ARCHITECTURE.md", "architecture.json", "PLAN.md", "plan.json", "STATE.md"]) expect(existsSync(join(p.repoPath, "docs", f))).toBe(true);
    expect(readFileSync(join(p.repoPath, "docs", "PLAN.md"), "utf8")).toContain("### `p1-db` DB");
    const log = await execa("git", ["log", "--format=%s"], { cwd: p.repoPath });
    expect(log.stdout.split("\n")).toEqual(["docs: implementation plan", "docs: architecture", "chore: initialize workspace"]);
    expect((await execa("git", ["status", "--porcelain"], { cwd: p.repoPath })).stdout).toBe("");
  });

  it("cost profile clamps planner model choices", async () => {
    const { db, deps, project } = setup([architect(), review("approve"), planner(PLAN), review("approve")], "cost");
    await runPlanningToCompletion(deps, project.id);
    const db1 = db.select().from(schema.tasks).where(eq(schema.tasks.key, "p1-db")).get();
    expect(db1).toMatchObject({ model: "sonnet", effort: "medium", maxAttempts: 2 });
  });

  it("architecture rework resumes the architect session with the feedback", async () => {
    const { claude, deps, project, db } = setup([
      architect("arch-1"),
      review("rework", "Add authentication section"),
      architect("arch-1", "# Architecture v2\n\nWith auth."),
      review("approve"),
      planner(PLAN),
      review("approve"),
    ]);
    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    const second = claude.calls[2]!;
    expect(second.resumeSessionId).toBe("arch-1");
    expect(second.prompt).toContain("Add authentication section");
    expect(claude.calls[3]!.prompt).toContain("With auth.");
    expect(claude.calls[3]!.prompt).toContain("reviewer says rework");
  });

  it("an invalid plan is corrected once in the same session", async () => {
    const cyclic = structuredClone(PLAN);
    cyclic.phases[0]!.tasks[0]!.depends_on = ["p1-db"];
    const { claude, deps, project, db } = setup([architect(), review("approve"), planner(cyclic, "plan-1"), planner(PLAN, "plan-1"), review("approve")]);
    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    expect(claude.calls[3]!.resumeSessionId).toBe("plan-1");
    expect(claude.calls[3]!.prompt).toMatch(/cycle/);
  });

  it("escalation blocks the project; the owner's answer feeds the next architect run", async () => {
    const { claude, deps, project, db } = setup([architect(), review("escalate", "Which hosting provider?")]);
    const res = await runPlanningToCompletion(deps, project.id);
    expect(res.status).toBe("blocked");
    const blocked = getProject(db, project.id);
    expect(blocked).toMatchObject({ status: "blocked", blockedFrom: "architecting" });
    expect(blocked.blockedReason).toContain("Which hosting provider?");

    const unblocked = answerAndUnblock(deps, "links", "Use Fly.io");
    expect(unblocked.status).toBe("architecting");

    claude.enqueue(architect("arch-2"), review("approve"));
    await advancePlanning(deps, project.id);
    expect(claude.calls[2]!.prompt).toContain("Use Fly.io");
    expect(getProject(db, project.id).status).toBe("planning");
  });

  it("a limit during the architect run interrupts without using an attempt", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { deps, project, db } = setup([() => FakeClaudeClient.limited(resetsAt)]);
    const res = await advancePlanning(deps, project.id);
    expect(res.status).toBe("interrupted");
    expect(getProject(db, project.id).status).toBe("architecting");
    expect(loadLimit(db).status).toBe("limited");
  });

  it("if the review is interrupted, the next step only re-runs the review", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 60;
    const { claude, deps, project, db } = setup([architect(), () => FakeClaudeClient.limited(resetsAt), review("approve")]);
    expect((await advancePlanning(deps, project.id)).status).toBe("interrupted");
    expect((await advancePlanning(deps, project.id)).status).toBe("progressed");
    expect(claude.calls).toHaveLength(3);
    expect(isReview(claude.calls[2]!)).toBe(true);
    expect(getProject(db, project.id).status).toBe("planning");
  });

  it("blocks after the attempt budget is used up", async () => {
    const { deps, project, db } = setup([
      architect(), review("rework", "a"),
      architect(), review("rework", "b"),
      architect(), review("rework", "c"),
    ]);
    const res = await runPlanningToCompletion(deps, project.id);
    expect(res.status).toBe("blocked");
    expect(getProject(db, project.id).blockedReason).toMatch(/attempt budget/);
  });

  it("architect output without the document is corrected, then counted as a failure", async () => {
    const noDoc: Handler = () => FakeClaudeClient.ok(json({ stack: [] }), { sessionId: "a" });
    const { claude, deps, project, db } = setup([noDoc, noDoc]);
    const res = await advancePlanning(deps, project.id);
    expect(res.status).toBe("failed");
    expect(claude.calls[1]!.prompt).toContain("was not written");
    const runs = db.select().from(schema.runs).all();
    expect(runs.map((r) => r.errorKind)).toEqual([null, "parse"]);
  });
});

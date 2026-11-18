import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { advanceExecution } from "../src/loops/execution.js";
import { advancePlanning, runPlanningToCompletion } from "../src/loops/planning.js";
import { BriefSchema } from "../src/projects/brief.js";
import { decideAfterMapping, GateError, readMap } from "../src/projects/ownerGate.js";
import { createProjectFromBrief, getProject, startProject } from "../src/projects/repo.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { buildServer } from "../src/server/index.js";
import { json, makeOwnerRepo, MAP, mapper, PLAN, planner, review, setup, worker } from "./helpers.js";
import { execa } from "execa";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { LocalRunner } from "../src/runner/local.js";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/** An existing-repo project in status `mapping`, with a scripted Claude. */
async function mappingProject(mode: "existing" | "rework", script: Parameters<typeof FakeClaudeClient.prototype.enqueue>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aipm-map-")));
  const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects") });
  const db = openDb(":memory:");
  const claude = new FakeClaudeClient([...script]);
  const deps = { db, runner: new LocalRunner(claude), config };
  const repo = await makeOwnerRepo(join(dir, "app"), { "README.md": "# App\n", "src/index.js": "console.log(1)\n" });
  const details =
    mode === "existing"
      ? { existing: { currentState: "The CLI prints 1. Nothing else.", offLimits: ["vendor/"] } }
      : { rework: { kinds: ["tests", "refactor"], successCriteria: ["coverage ≥ 80%"], behaviorFrozen: true, scope: ["src/"] } };
  const brief = BriefSchema.parse({ slug: "app", name: "App", problem: "A tiny CLI that prints numbers.", mode, repoPath: repo.dir, ...details });
  const project = startProject(db, await createProjectFromBrief(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" }));
  const git = async (...args: string[]) => (await execa("git", args, { cwd: repo.dir })).stdout;
  return { db, deps, claude, project, git, repo };
}

describe("mapper", () => {
  it("maps on ai-pm/main, keeps only .aipm/ changes, and waits for the owner", async () => {
    const { db, deps, claude, project, git } = await mappingProject("existing", [mapper, review("approve")]);
    expect(project.status).toBe("mapping");
    await runPlanningToCompletion(deps, project.id);

    const p = getProject(db, project.id);
    expect(p).toMatchObject({ status: "awaiting_owner", ownerGate: "pick_proposals" });
    const req = claude.calls[0]!;
    expect(req.prompt).toContain("joining an **existing** software project");
    expect(req.prompt).toContain("The CLI prints 1. Nothing else.");
    expect(req.prompt).toContain("`vendor/`".replace(/`/g, "")); // off-limits listed in the brief
    expect(req.prompt).toContain(".aipm/MAP.md");
    expect(req.disallowedTools).toContain("Bash(git commit:*)");

    // The mapper edited README.md and left coverage.txt: both are gone, the map is committed.
    expect(readFileSync(join(p.repoPath, "README.md"), "utf8")).toBe("# App\n");
    expect(existsSync(join(p.repoPath, "coverage.txt"))).toBe(false);
    expect(await git("branch", "--show-current")).toBe("ai-pm/main");
    expect(await git("log", "-1", "--format=%s")).toBe("aipm: map the repository");
    expect((await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual([".aipm/MAP.md", ".aipm/map.json"]);
    expect(await git("log", "--format=%s", "trunk")).toBe("owner: initial");
    expect(readMap(p)!.proposals.map((x) => x.id)).toEqual(["P1", "P2"]);
  });

  it("the owner's choice becomes GOALS.md and drives an existing-repo planner", async () => {
    const { db, deps, claude, project, git } = await mappingProject("existing", [mapper, review("approve"), planner(PLAN), review("approve")]);
    await runPlanningToCompletion(deps, project.id);

    await expect(decideAfterMapping(deps, project.id, { picked: ["P9"], notes: "" })).rejects.toThrow(/unknown proposal ids: P9/);
    await expect(decideAfterMapping(deps, project.id, { picked: [], notes: "" })).rejects.toThrow(GateError);
    const p = await decideAfterMapping(deps, project.id, { picked: ["P1"], notes: "Only the files, no CI yet." });
    expect(p.status).toBe("planning");
    const goals = readFileSync(join(p.repoPath, ".aipm/GOALS.md"), "utf8");
    expect(goals).toContain("**P1 — Create the three files**");
    expect(goals).not.toContain("P2");
    expect(goals).toContain("Only the files, no CI yet.");
    await expect(decideAfterMapping(deps, project.id, { picked: ["P1"], notes: "" })).rejects.toThrow(/not waiting/);

    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    const plannerPrompt = claude.calls[2]!.prompt;
    expect(plannerPrompt).toContain("Map of the existing codebase");
    expect(plannerPrompt).toContain("## What the owner chose");
    expect(plannerPrompt).toContain("**already exists**");
    expect(plannerPrompt).not.toContain("Phase 1 must set up the project skeleton");
    expect(await git("ls-tree", "--name-only", "ai-pm/main", ".aipm/")).toBe([".aipm/GOALS.md", ".aipm/MAP.md", ".aipm/PLAN.md", ".aipm/STATE.md", ".aipm/map.json", ".aipm/plan.json"].join("\n"));
    expect(existsSync(join(p.repoPath, "docs"))).toBe(false);
  });

  it("rework: the owner confirms the goal and criteria; the plan starts with characterization tests", async () => {
    const { db, deps, claude, project } = await mappingProject("rework", [mapper, review("approve"), planner(PLAN), review("approve")]);
    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "confirm_goal" });
    expect(claude.calls[0]!.prompt).toContain("this is a rework pass (Tests and coverage, Refactor the architecture)");
    expect(claude.calls[0]!.prompt).toContain("characterization tests");

    await decideAfterMapping(deps, project.id, { picked: ["P1"], notes: "", successCriteria: ["coverage ≥ 90%", "no file over 300 lines"] });
    expect(getProject(db, project.id).modeDetails.rework?.successCriteria).toEqual(["coverage ≥ 90%", "no file over 300 lines"]);
    await runPlanningToCompletion(deps, project.id);
    const prompt = claude.calls[2]!.prompt;
    expect(prompt).toContain("Behavior is **frozen**");
    expect(prompt).toContain("- coverage ≥ 90%");
    expect(prompt).toContain("Stay inside the scope paths");
  });

  it("a map without proposals gets one correction, then counts as unusable output", async () => {
    const noProposals: Parameters<typeof FakeClaudeClient.prototype.enqueue>[0] = (req) => {
      mkdirSync(join(req.cwd, ".aipm"), { recursive: true });
      writeFileSync(join(req.cwd, ".aipm", "MAP.md"), "# Map\n");
      return FakeClaudeClient.ok(json({ summary: "x", proposals: [] }), { sessionId: "m" });
    };
    const { db, deps, claude, project } = await mappingProject("existing", [noProposals, noProposals]);
    const r = await advancePlanning(deps, project.id);
    expect(r).toMatchObject({ status: "failed", message: "mapper produced unusable output" });
    expect(claude.calls[1]!.prompt).toMatch(/JSON block is unusable.*at least one proposal/s);
    expect(claude.calls[1]!.resumeSessionId).toBe("m");
    expect(getProject(db, project.id).status).toBe("mapping");
    const runs = db.select().from(schema.runs).all();
    expect(runs.at(-1)).toMatchObject({ kind: "mapper", errorKind: "parse" });
  });
});

describe("existing repo execution", () => {
  it("workers read .aipm/ docs and get the owner's off-limits rule", async () => {
    const { workerCalls, task, deps, project } = await setup([worker(["a.txt"]), review("approve")], { mode: "existing" });
    await advanceExecution(deps, project.id);
    const prompt = workerCalls()[0]!.prompt;
    expect(prompt).toContain("`.aipm/MAP.md` — the map of this existing codebase");
    expect(prompt).toContain("`.aipm/STATE.md`");
    expect(prompt).not.toContain("docs/ARCHITECTURE.md");
    expect(task("p1-a").status).toBe("done");
  });
});

describe("scheduler and API", () => {
  it("the scheduler runs the mapper, and the API serves the map and takes the owner's choice", async () => {
    const { db, deps, project } = await mappingProject("existing", [mapper, review("approve")]);
    const s = new Scheduler(deps);
    expect(await s.tick()).toMatchObject({ kind: "ran", step: { status: "progressed" } });
    expect(getProject(db, project.id).status).toBe("awaiting_owner");
    expect(await s.tick()).toEqual({ kind: "idle" }); // waiting for the owner is not work

    const server = buildServer({ app: { ...deps, db }, webDir: null });
    const map = (await server.inject({ method: "GET", url: "/api/projects/app/map" })).json();
    expect(map.map.proposals[0]).toMatchObject({ id: "P1", recommended: true, effort: "S" });
    expect(map.markdown).toContain("# Map");
    const bad = await server.inject({ method: "POST", url: "/api/projects/app/choose", payload: { picked: ["nope"] } });
    expect(bad.statusCode).toBe(409);
    const ok = await server.inject({ method: "POST", url: "/api/projects/app/choose", payload: { picked: ["P1", "P2"], notes: "both" } });
    expect(ok.json()).toMatchObject({ status: "planning", ownerGate: null });
  });
});

void MAP;

describe("map reuse", () => {
  it("a second test-mode project on the same, unchanged repo reuses the approved map; a changed repo is mapped again", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aipm-reuse-")));
    const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects"), AIPM_SANDBOX_DIR: join(dir, "sandbox") });
    const db = openDb(":memory:");
    const claude = new FakeClaudeClient([mapper, review("approve")]);
    const deps = { db, runner: new LocalRunner(claude), config };
    const repo = await makeOwnerRepo(join(dir, "app"), { "README.md": "# App\n" });
    const make = async (slug: string) => {
      const brief = BriefSchema.parse({ slug, name: slug, problem: "A tiny app to improve.", mode: "existing", repoPath: repo.dir, workspace: "sandbox", existing: { currentState: "A readme only." } });
      return startProject(db, await createProjectFromBrief(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced", sandboxDir: config.AIPM_SANDBOX_DIR }));
    };

    const first = await make("try1");
    await runPlanningToCompletion(deps, first.id);
    expect(getProject(db, first.id).status).toBe("awaiting_owner");
    expect(claude.calls).toHaveLength(2);

    const second = await make("try2");
    expect((await advancePlanning(deps, second.id)).message).toMatch(/reused from try1/);
    expect(claude.calls).toHaveLength(2); // no mapper, no review
    expect(getProject(db, second.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "pick_proposals" });
    expect(readMap(getProject(db, second.id))?.proposals[0]?.id).toBe("P1");

    await repo.git("commit", "-q", "--allow-empty", "-m", "noop"); // same tree: still reusable
    writeFileSync(join(repo.dir, "README.md"), "# App v2\n");
    await repo.git("commit", "-qam", "change");
    claude.enqueue(mapper, review("approve"));
    const third = await make("try3");
    await runPlanningToCompletion(deps, third.id);
    expect(claude.calls).toHaveLength(4); // mapped again
  });
});


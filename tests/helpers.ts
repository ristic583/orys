/** Shared fixtures for loop and scheduler tests: scripted Claude handlers and a demo plan. */
import { execa } from "execa";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { FakeClaudeClient, type FakeHandler } from "../src/claude/client.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import type { LoopDeps } from "../src/loops/common.js";
import { runPlanningToCompletion } from "../src/loops/planning.js";
import type { PlanInput as Plan } from "../src/loops/plan.js";
import { BriefSchema } from "../src/projects/brief.js";
import { applyProjectEvent, createProject, createProjectFromBrief, getProject, startProject } from "../src/projects/repo.js";
import { decideAfterMapping } from "../src/projects/ownerGate.js";
import { approvePlan } from "../src/projects/planEditor.js";
import { LocalRunner } from "../src/runner/local.js";

export type Handler = FakeHandler;
export const json = (v: unknown) => `Done.\n<<<JSON\n${JSON.stringify(v)}\nJSON>>>`;

export const architect: Handler = (req) => {
  mkdirSync(join(req.cwd, "docs"), { recursive: true });
  writeFileSync(join(req.cwd, "docs", "ARCHITECTURE.md"), "# Arch");
  return FakeClaudeClient.ok(json({ stack: ["sh"] }), { sessionId: "arch" });
};
export const review = (decision: "approve" | "rework" | "escalate", feedback = ""): Handler => () =>
  FakeClaudeClient.ok(json({ decision, rationale: `reviewer: ${decision}`, feedback }), { sessionId: "rev" });
/** The handoff note at the end of a project: every promise delivered. */
export const handoff: Handler = () =>
  FakeClaudeClient.ok(json({ summary_plain: "The three files are there, in order.", delivered: [{ promise: "Repository root: Files a.txt, b.txt and c.txt", status: "done" }], how_to_see: ["ls"], known_gaps: [] }), { sessionId: "handoff" });
export const planner = (plan: Plan): Handler => () => FakeClaudeClient.ok(json(plan), { sessionId: "plan" });
/** A worker that creates files (and optionally does nothing useful). */
export const worker = (files: string[], sessionId = "w"): Handler => (req) => {
  for (const f of files) writeFileSync(join(req.cwd, f), `${f}\n`);
  return FakeClaudeClient.ok(json({ summary: `wrote ${files.join(", ")}` }), { sessionId });
};

const t = (key: string, file: string, depends_on: string[] = []) => ({
  key, title: `make ${file}`, spec: `create ${file}`, acceptance: [`${file} exists`], verify_commands: [`test -f ${file}`], depends_on,
});
/** A medium, medium-risk job: the "standard" process, which keeps the profile's review settings. */
export const SCOPE: Plan["scope"] = { size: "M", risk: "medium", ui: false, reason: "Three small files in a fixed order." };
export const OUTCOME: Plan["outcome"] = {
  summary_plain: "The repository gets three text files, a, b and c, created one after the other.",
  you_will_see: [{ where: "Repository root", what: "Files a.txt, b.txt and c.txt" }],
  stays_the_same: ["Everything else in the repository"],
  visible_change: "little",
  to_see_it: [],
  open_questions: [{ question: "Should the files be empty?", proposed_answer: "No, each holds its own name", why_it_matters: "Changes the content" }],
};
export const PLAN: Plan = {
  scope: SCOPE,
  outcome: OUTCOME,
  phases: [
    { title: "One", goal: "a and b", goal_plain: "You can open a.txt and b.txt", visible: true, tasks: [t("p1-a", "a.txt"), t("p1-b", "b.txt", ["p1-a"])] },
    { title: "Two", goal: "c", goal_plain: "You can open c.txt", visible: true, tasks: [t("p2-c", "c.txt", ["p1-b"])] },
  ],
};
export const PLANNING: Handler[] = [architect, review("approve"), planner(PLAN), review("approve", "Remember to add an index on clicks.code")];

export const MAP = {
  summary: "A tiny repo with a README.",
  stack: ["sh"],
  commands: { test: "true" },
  verify_commands: ["true"],
  baseline: { tests: "none" },
  proposals: [
    { id: "P1", title: "Create the three files", why: "The owner wants them", category: "feature", effort: "S", risk: "low", recommended: true },
    { id: "P2", title: "Add CI", why: "Nice to have", category: "infra", effort: "M", risk: "low" },
  ],
};
/** A mapper that writes the map (and, misbehaving, touches a tracked file and leaves a stray file). */
export const mapper: Handler = (req) => {
  mkdirSync(join(req.cwd, ".aipm"), { recursive: true });
  writeFileSync(join(req.cwd, ".aipm", "MAP.md"), "# Map\n\nA tiny repo.\n");
  writeFileSync(join(req.cwd, "README.md"), "changed by the mapper\n");
  writeFileSync(join(req.cwd, "coverage.txt"), "stray\n");
  return FakeClaudeClient.ok(json(MAP), { sessionId: "map" });
};

/** A git repo with one commit on branch `trunk`, standing in for the owner's existing project. */
export async function makeOwnerRepo(dir: string, files: Record<string, string> = { "README.md": "# Owner project\n" }) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execa("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.com", ...args], { cwd: dir });
  await git("init", "-q", "-b", "trunk");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "owner: initial");
  return { dir, git };
}

/**
 * A fresh in-memory app with one project ("demo"), optionally already planned (status `executing`).
 * With `mode: "existing"` the project lives in a separate owner repo on branch `trunk`.
 */
export async function setup(script: Handler[], opts: { profile?: "balanced" | "cost"; planned?: boolean; approve?: boolean; mode?: "scratch" | "existing" } = {}) {
  const planned = opts.planned ?? true;
  const dir = mkdtempSync(join(tmpdir(), "aipm-test-"));
  const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects") });
  const db = openDb(":memory:");
  const existing = opts.mode === "existing";
  // Scratch: architect → review → planner → review. Existing repo: mapper → review → (owner) → planner → review.
  const planning = existing ? [mapper, review("approve"), planner(PLAN), review("approve", "Remember to add an index on clicks.code")] : PLANNING;
  const claude = new FakeClaudeClient([...(planned ? planning : []), ...script]);
  const deps: LoopDeps = { db, runner: new LocalRunner(claude), config };
  const common = { slug: "demo", name: "Demo", problem: "Create three files in order.", profile: opts.profile ?? "balanced" };
  let project;
  if (opts.mode === "existing") {
    const repo = await makeOwnerRepo(join(dir, "owner-repo"));
    const brief = BriefSchema.parse({ ...common, mode: "existing", repoPath: repo.dir, existing: { currentState: "A readme exists, nothing else yet." } });
    project = await createProjectFromBrief(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" });
    project = startProject(db, project);
    if (planned) {
      await runPlanningToCompletion(deps, project.id);
      expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "pick_proposals" });
      await decideAfterMapping(deps, project.id, { picked: ["P1"], notes: "Keep it simple." });
    }  } else {
    const brief = BriefSchema.parse(common);
    project = createProject(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" });
    project = applyProjectEvent(db, project, { type: "start" });
  }
  if (planned) {
    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    if (opts.approve ?? true) {
      approvePlan(db, project.id);
      expect(getProject(db, project.id).status).toBe("executing");
    }
  }
  const offset = planned ? PLANNING.length : 0;
  const workerCalls = () => claude.calls.slice(offset);
  const task = (key: string) => db.select().from(schema.tasks).where(eq(schema.tasks.key, key)).get()!;
  const git = async (...args: string[]) => (await execa("git", args, { cwd: project.repoPath })).stdout;
  return { db, claude, deps, config, project, workerCalls, task, git };
}

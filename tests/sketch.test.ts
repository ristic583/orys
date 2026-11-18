/** Sketch first (SPEC §22.7): something to look at within minutes, agreed before anything is planned. */
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { runPlanningToCompletion } from "../src/loops/planning.js";
import { latestSketch, listSketches, normalizeSketch } from "../src/loops/sketch.js";
import { BriefSchema } from "../src/projects/brief.js";
import { decideAfterMapping } from "../src/projects/ownerGate.js";
import { approveSketch, outcomeView, ownerMetrics, reviseSketch, sketchView } from "../src/projects/outcome.js";
import { approvePlan } from "../src/projects/planEditor.js";
import { createProject, createProjectFromBrief, getProject, startProject } from "../src/projects/repo.js";
import { runExecution } from "../src/loops/execution.js";
import { LocalRunner } from "../src/runner/local.js";
import { architect, json, makeOwnerRepo, mapper, PLAN, planner, review, worker, type Handler } from "./helpers.js";

const QUICK = { ...PLAN, scope: { size: "S", risk: "low", ui: true, reason: "Three small files." } } as const;

/** A sketch run: writes screenshots into the version folder named in the prompt, plus a sketched file. */
const sketch = (over: Record<string, unknown> = {}, files = ["main-1280.png", "main-375.png"], sessionId = "sk"): Handler => (req) => {
  const v = /\.orys\/sketch\/(v\d+)/.exec(req.prompt)?.[1] ?? "v1";
  const dir = join(req.cwd, ".orys", "sketch", v);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "png");
  writeFileSync(join(req.cwd, "sketch-app.js"), `// ${v}\n`);
  return FakeClaudeClient.ok(json({
    summary_plain: `A rough main screen (${v}) with the three files listed.`,
    screens: files.map((file) => ({ file, caption: "main" })),
    what_is_real: ["the layout"],
    what_is_faked: ["the file list is hard-coded"],
    how_to_run: "node sketch-app.js",
    stack: ["Node 26"],
    verify_commands: ["true"],
    scope: { size: "S", risk: "low", ui: true, reason: "One small screen." },
    ...over,
  }), { sessionId });
};

async function scratch(script: Handler[], slug = "demo") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aipm-sketch-")));
  const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects") });
  const db = openDb(":memory:");
  const claude = new FakeClaudeClient(script);
  const deps = { db, runner: new LocalRunner(claude), config };
  const brief = BriefSchema.parse({ slug, name: "Demo", problem: "A page that lists three files." });
  const project = startProject(db, createProject(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" }), { sketch: true });
  const git = async (...args: string[]) => (await execa("git", args, { cwd: project.repoPath })).stdout;
  return { db, deps, claude, config, project, git, dir };
}

describe("sketch first", () => {
  it("sketch → owner reacts → v2 in the same session → agreed → plan from the sketch, no architect", async () => {
    const { db, deps, claude, project, git } = await scratch([sketch(), sketch({}, undefined, "sk2"), planner(QUICK)]);
    expect(project.status).toBe("sketching");

    await runPlanningToCompletion(deps, project.id);
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_sketch" });
    expect(claude.calls[0]!.prompt).toContain("You are making a **sketch**");
    expect(claude.calls[0]!.prompt).toContain(".orys/sketch/v1");
    expect(await git("log", "--format=%s", "orys/sketch")).toContain("sketch v1");
    expect(await git("log", "--format=%s", "main")).not.toContain("sketch v1"); // the sketch stays on its own branch
    expect(sketchView(db, project.id)).toMatchObject({ waiting: true, versions: [{ version: 1, status: "ready", screens: [{ file: "main-1280.png" }, { file: "main-375.png" }] }] });

    expect(ownerMetrics(db).firstSketchMinutes).toBeGreaterThanOrEqual(0);
    reviseSketch(db, project.id, { message: "Bigger titles please" });
    expect(getProject(db, project.id).status).toBe("sketching");
    await runPlanningToCompletion(deps, project.id);
    const v2 = claude.calls[1]!;
    expect(v2.resumeSessionId).toBe("sk"); // the sketch's own session: it remembers v1
    expect(v2.prompt).toContain("Bigger titles please");
    expect(v2.prompt).toContain(".orys/sketch/v2");
    expect(listSketches(db, project.id).map((s) => s.status)).toEqual(["revise", "ready"]);

    await approveSketch(deps, project.id);
    expect(getProject(db, project.id).status).toBe("planning"); // S: no architect
    expect(readFileSync(join(project.repoPath, "docs", "ARCHITECTURE.md"), "utf8")).toContain("from the agreed sketch");
    expect(existsSync(join(project.repoPath, ".orys", "sketch", "code", "sketch-app.js"))).toBe(true);

    await runPlanningToCompletion(deps, project.id);
    const plannerPrompt = claude.calls[2]!.prompt;
    expect(plannerPrompt).toContain("The sketch the owner agreed on (v2)");
    expect(plannerPrompt).toContain("`.orys/sketch/v2/main-1280.png`");
    expect(plannerPrompt).toContain("Bigger titles please");
    expect(plannerPrompt).not.toContain("no longer be shown"); // a new project has nothing to lose
    expect(plannerPrompt).toContain("- `.orys/sketch/code/sketch-app.js`"); // exact paths, no guessing
    expect(getProject(db, project.id)).toMatchObject({ status: "awaiting_owner", ownerGate: "approve_plan" });
    expect(outcomeView(db, project.id).sketch).toMatchObject({ version: 2, screens: [{ file: "main-1280.png" }, { file: "main-375.png" }] });

    approvePlan(db, project.id);
    claude.enqueue(worker(["a.txt"]));
    await runExecution(deps, project.id, { stopAfterTasksDone: 1 });
    expect(claude.calls[3]!.prompt).toContain("match the sketch's layout");
  });

  it("big work (L) gets the architect after the agreement, and the architect sees the sketch", async () => {
    const { db, deps, claude, project } = await scratch([sketch({ scope: { size: "L", risk: "medium", ui: true, reason: "A whole app." } }), architect]);
    await runPlanningToCompletion(deps, project.id);
    await approveSketch(deps, project.id);
    expect(getProject(db, project.id).status).toBe("architecting");
    await runPlanningToCompletion(deps, project.id).catch(() => undefined); // architect runs, then the script ends
    expect(claude.calls[1]!.prompt).toContain("The sketch the owner agreed on (v1)");
  });

  it("directions: the owner must pick one; the plan sees that direction's screens", async () => {
    const directions = [
      { id: "calm", title: "Calm", idea: "One big status", screens: ["calm-1280.png"] },
      { id: "dense", title: "Dense", idea: "One table", screens: ["dense-1280.png"] },
    ];
    const { db, deps, claude, project } = await scratch([sketch({ screens: [], directions, scope: { size: "S", risk: "low", ui: true, design_directions: true, reason: "Open look." } }, ["calm-1280.png", "dense-1280.png"]), planner(QUICK)]);
    await runPlanningToCompletion(deps, project.id);
    await expect(approveSketch(deps, project.id)).rejects.toThrow(/pick one of the directions/);
    await approveSketch(deps, project.id, { direction: "dense" });
    await runPlanningToCompletion(deps, project.id);
    expect(claude.calls[1]!.prompt).toContain("Chosen direction: **Dense**");
    expect(claude.calls[1]!.prompt).toContain("`.orys/sketch/v1/dense-1280.png`");
    expect(claude.calls[1]!.prompt).not.toContain("calm-1280.png");
  });

  it("nothing to show (tests only): no owner stop, straight on", async () => {
    const { db, deps, project } = await scratch([sketch({ screens: [], nothing_to_show: true, scope: { size: "S", risk: "low", ui: false, reason: "Only tests." } }, [])]);
    await runPlanningToCompletion(deps, project.id).catch(() => undefined);
    expect(latestSketch(db, project.id)?.status).toBe("skipped");
    expect(["planning", "awaiting_owner"]).toContain(getProject(db, project.id).status);
    expect(getProject(db, project.id).ownerGate).not.toBe("approve_sketch");
  });

  it("a sketch that fails twice does not stall the project: it continues the old way", async () => {
    const broken: Handler = () => FakeClaudeClient.ok("no json here", { sessionId: "x" });
    const { db, deps, project } = await scratch([broken, broken, broken, broken, architect]);
    await runPlanningToCompletion(deps, project.id).catch(() => undefined); // two failed steps (each with a correction round)
    expect(getProject(db, project.id).status).toBe("sketching");
    await runPlanningToCompletion(deps, project.id).catch(() => undefined); // the scheduler tries again: now it gives up on sketching
    expect(db.select().from(schema.events).all().some((e) => e.type === "sketch_skipped")).toBe(true);
    expect(["architecting", "planning", "awaiting_owner"]).toContain(getProject(db, project.id).status);
  });
});

describe("sketch first in an existing repo", () => {
  async function existing(script: Handler[], nextGoals: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aipm-sketch-ex-")));
    const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(dir, "runs"), AIPM_PROJECTS_DIR: join(dir, "projects") });
    const db = openDb(":memory:");
    const claude = new FakeClaudeClient(script);
    const deps = { db, runner: new LocalRunner(claude), config };
    const repo = await makeOwnerRepo(join(dir, "app"));
    const brief = BriefSchema.parse({ slug: "app", name: "App", problem: "An app to improve.", mode: "existing", repoPath: repo.dir, existing: { currentState: "A readme only, nothing more.", nextGoals } });
    const project = startProject(db, await createProjectFromBrief(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced" }), { sketch: true });
    return { db, deps, claude, project, repo };
  }

  it("a stated goal is sketched first; agreed S work skips the mapper and the owner's branch is untouched", async () => {
    const { db, deps, claude, project, repo } = await existing([sketch({ no_longer_shown: ["The swap line under memory"] }), planner(QUICK)], "Show the three files on a page");
    expect(project.status).toBe("sketching");
    await runPlanningToCompletion(deps, project.id);
    expect(claude.calls[0]!.prompt).toContain("existing repository");
    await approveSketch(deps, project.id);
    expect(getProject(db, project.id).status).toBe("planning");
    expect(readFileSync(join(project.repoPath, ".aipm", "MAP.md"), "utf8")).toContain("Repository notes (from the agreed sketch)");
    expect(readFileSync(join(project.repoPath, ".aipm", "GOALS.md"), "utf8")).toContain("Agreed on sketch v1");
    expect(readFileSync(join(project.repoPath, ".aipm", "GOALS.md"), "utf8")).toContain("No longer shown (agreed): The swap line under memory");
    await runPlanningToCompletion(deps, project.id);
    expect(claude.calls.map((c) => c.prompt.slice(0, 40))).toHaveLength(2); // sketch, planner: no mapper
    expect((await repo.git("log", "--format=%s", "trunk")).stdout).toBe("owner: initial");

    // What goes away was agreed with the sketch: the plan may drop only that, and the worker must keep the rest.
    expect(claude.calls[1]!.prompt).toContain("will **no longer be shown**:\n- The swap line under memory");
    expect(claude.calls[1]!.prompt).toContain("Everything else the owner sees today stays");
    expect(outcomeView(db, project.id).sketch?.noLongerShown).toEqual(["The swap line under memory"]);
    approvePlan(db, project.id);
    claude.enqueue(worker(["a.txt"]));
    await runExecution(deps, project.id, { stopAfterTasksDone: 1 });
    expect(claude.calls[2]!.prompt).toContain("Do not remove anything the owner sees today");
  });

  it("directions: each says what it drops; only the chosen one's list reaches the plan", async () => {
    const directions = [
      { id: "calm", title: "Calm", idea: "One big status", screens: ["calm-1280.png"], no_longer_shown: ["The uptime line"] },
      { id: "dense", title: "Dense", idea: "One table", screens: ["dense-1280.png"], no_longer_shown: ["Per-file icons"] },
    ];
    const look = sketch({ screens: [], directions, no_longer_shown: ["The footer"], scope: { size: "S", risk: "low", ui: true, design_directions: true, reason: "Open look." } }, ["calm-1280.png", "dense-1280.png"]);
    const { db, deps, claude, project } = await existing([look, planner(QUICK)], "Make the page calmer");
    await runPlanningToCompletion(deps, project.id);
    expect(sketchView(db, project.id).versions[0]).toMatchObject({ no_longer_shown: ["The footer"], directions: [{ no_longer_shown: ["The uptime line"] }, { no_longer_shown: ["Per-file icons"] }] });
    await approveSketch(deps, project.id, { direction: "dense" });
    await runPlanningToCompletion(deps, project.id);
    const plan = claude.calls[1]!.prompt;
    expect(plan).toContain("- The footer\n- Per-file icons");
    expect(plan).not.toContain("The uptime line");
    expect(outcomeView(db, project.id).sketch?.noLongerShown).toEqual(["The footer", "Per-file icons"]);
  });

  it("a sketch stored before the list existed: agents keep everything, the page claims nothing", async () => {
    const { db, deps, claude, project } = await existing([sketch(), planner(QUICK)], "Show the three files on a page");
    await runPlanningToCompletion(deps, project.id);
    const row = latestSketch(db, project.id)!;
    const { no_longer_shown: _, ...old } = row.summary;
    db.update(schema.sketches).set({ summary: old as typeof row.summary }).where(eq(schema.sketches.id, row.id)).run();
    expect(sketchView(db, project.id).versions[0]!.no_longer_shown).toBeUndefined(); // unknown: the page claims nothing
    await approveSketch(deps, project.id);
    await runPlanningToCompletion(deps, project.id);
    expect(claude.calls[1]!.prompt).toContain("The owner agreed to **no removals**");
    expect(outcomeView(db, project.id).sketch?.noLongerShown).toBeNull();
  });

  it("no goal: map and propose first; picking a visible proposal leads to a sketch", async () => {
    const { db, deps, project } = await existing([mapper, review("approve")], "");
    expect(project.status).toBe("mapping");
    await runPlanningToCompletion(deps, project.id);
    const p = await decideAfterMapping(deps, project.id, { picked: ["P1"], notes: "" }); // P1 is a "feature"
    expect(p.status).toBe("sketching");
  });
});

describe("normalizeSketch", () => {
  it("gives directions back the screenshots the agent listed only among the main screens", () => {
    const s = normalizeSketch({
      summary_plain: "x".repeat(30), screens: [{ file: "before-1280.png", caption: "" }, { file: "deck-1280.png", caption: "" }, { file: "deck-375.png", caption: "" }, { file: "console-1280.png", caption: "" }],
      demo: [], what_is_real: [], what_is_faked: [], how_to_run: "", stack: [], verify_commands: [], nothing_to_show: false,
      scope: { size: "M", risk: "low", ui: true, design_directions: true, reason: "r" },
      no_longer_shown: [],
      directions: [{ id: "deck", title: "Deck", idea: "i", screens: [], no_longer_shown: [] }, { id: "console", title: "Console", idea: "i", screens: [], no_longer_shown: [] }],
    });
    expect(s.directions.map((d) => d.screens)).toEqual([["deck-1280.png", "deck-375.png"], ["console-1280.png"]]);
  });
});

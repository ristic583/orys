/**
 * Sketch first (SPEC §22.7): within minutes of starting, one agent makes
 * something the owner can look at (screens, directions, or a demo) on its own
 * branch. The owner reacts; each reaction is a new version in the same
 * session. When they agree, the sketch becomes the spec: small and medium
 * work goes straight to the plan, big work gets the full map or architecture
 * first. Nothing here is built properly; that is the plan's job.
 */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { SketchSchema, type SketchOutput } from "../core/outcome.js";
import type { DbOrTx } from "../db/index.js";
import { decisions, runs, sketches, type Project, type Sketch } from "../db/schema.js";
import { checkoutBranch, commitAll, commitPaths, ensureLocalExclude, isDirty, shq } from "../git/index.js";
import { briefVars } from "../projects/brief.js";
import { slotOf } from "../sessions/slots.js";
import { docPaths } from "../projects/docs.js";
import { applyProjectEvent, getProject, listFeatures, logEvent } from "../projects/repo.js";
import { bullets, renderPrompt } from "../prompts/render.js";
import { NO_GIT, builderRun, isInterrupt, markRunParseError, roleOf, ws, type LoopDeps, type StepResult } from "./common.js";

export const SKETCH_ROOT = ".orys/sketch";
export const sketchDir = (version: number) => `${SKETCH_ROOT}/v${version}`;
export const SKETCH_CODE_DIR = `${SKETCH_ROOT}/code`;
/** The sketch lives on its own branch; the owner's branch and Orys's integration branch never see it. */
export const sketchBranch = (p: Pick<Project, "mode">) => (p.mode === "scratch" ? "orys/sketch" : "ai-pm/sketch");
const baseOf = (p: Project) => (p.mode === "scratch" ? "main" : (p.baseBranch ?? "main"));

export const listSketches = (db: DbOrTx, projectId: string): Sketch[] => db.select().from(sketches).where(eq(sketches.projectId, projectId)).orderBy(asc(sketches.version)).all();
export const latestSketch = (db: DbOrTx, projectId: string): Sketch | undefined => db.select().from(sketches).where(eq(sketches.projectId, projectId)).orderBy(desc(sketches.version)).get();
/** The version the owner agreed on (or the one that had nothing to show). */
export const agreedSketch = (db: DbOrTx, projectId: string): Sketch | undefined =>
  db.select().from(sketches).where(and(eq(sketches.projectId, projectId), inArray(sketches.status, ["approved", "skipped"]))).orderBy(desc(sketches.version)).get();

/**
 * Directions whose screenshots the agent listed only among the main screens
 * (seen in the first real run: "deck-1280.png" in `screens`, none on the
 * direction) get them back by name.
 */
export function normalizeSketch(s: SketchOutput): SketchOutput {
  return {
    ...s,
    no_longer_shown: s.no_longer_shown ?? [], // sketches stored before the field existed
    directions: s.directions.map((d) => ({
      ...d,
      no_longer_shown: d.no_longer_shown ?? [],
      screens: d.screens.length ? d.screens : s.screens.map((x) => x.file).filter((f) => f.startsWith(`${d.id}-`) || f.startsWith(`${d.id}.`)),
    })),
  };
}

/** What the owner agreed will no longer be shown: the sketch's list plus the chosen direction's. */
export function noLongerShown(s: Pick<Sketch, "summary" | "direction">): string[] {
  const n = normalizeSketch(s.summary);
  const dir = s.direction ? n.directions.find((d) => d.id === s.direction) : undefined;
  return [...new Set([...n.no_longer_shown, ...(dir?.no_longer_shown ?? [])])];
}

/** Screens of a version: the chosen direction's when the owner picked one, else the main ones. */
export function sketchScreens(s: Sketch): { file: string; caption: string }[] {
  const dir = s.direction ? normalizeSketch(s.summary).directions.find((d) => d.id === s.direction) : undefined;
  return dir ? dir.screens.map((file) => ({ file, caption: dir.title })) : s.summary.screens;
}

// ─────────────────────────── the sketch run ───────────────────────────

export async function sketchStep(deps: LoopDeps, project: Project): Promise<StepResult> {
  const { db, runner, config } = deps;
  const latest = latestSketch(db, project.id);
  if (latest?.status === "ready") return { status: "idle", message: "sketch waits for the owner" };
  const version = (latest?.version ?? 0) + 1;
  const revising = latest?.status === "revise" ? latest : undefined;

  // Two broken tries for this version: give up on sketching and go the old way, rather than stall.
  const failures = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, project.id), eq(runs.kind, "sketch"), inArray(runs.errorKind, ["crash", "timeout", "parse"]), gt(runs.id, latest?.id ?? "")))
    .all().length;
  if (failures >= 2) {
    logEvent(db, project.id, "sketch_skipped", { reason: "failed twice", version });
    const next = project.mode === "scratch" ? "architecting" : "mapping";
    applyProjectEvent(db, getProject(db, project.id), { type: "sketch_done", next });
    return { status: "progressed", message: `sketch failed twice — continuing with ${next}` };
  }

  const w = ws(project);
  await checkoutBranch(runner, w, sketchBranch(project), baseOf(project));
  ensureLocalExclude(project.repoPath, ".orys/");
  if (await isDirty(runner, w)) await commitAll(runner, w, `sketch: partial work before resume`);
  const dir = sketchDir(version);
  mkdirSync(join(project.repoPath, dir), { recursive: true });

  const full = renderPrompt("sketch", {
    ...briefVars(project, listFeatures(db, project.id)),
    goals: goalsText(project),
    where: whereText(project),
    screens_dir: dir,
    summary_language: config.AIPM_SUMMARY_LANGUAGE,
  });
  const revise = revising
    ? renderPrompt("sketch-revise", {
        previous: String(revising.version),
        version: String(version),
        feedback: (revising.feedback ?? "").replace(/\n/g, "\n> "),
        screens_dir: dir,
        direction_hint: revising.direction ? `They liked direction "${revising.direction}": continue from that one only.` : "",
      })
    : "";
  // A revision continues the sketch's session (cheap, it remembers); without one, it gets everything.
  const session = slotOf(db, project.id)?.sessionId;
  const prompt = revising && session ? revise : revising ? `${full}\n\n---\n\n${revise}` : full;

  const role = roleOf(project, "architect");
  const req = { model: role.model, effort: role.effort, permissionMode: project.workerPermissionMode, disallowedTools: NO_GIT, timeoutMs: config.timeouts.sketch };
  const ctx = { kind: "sketch" as const, projectId: project.id };
  let { run, outcome } = await builderRun(deps, project, w, ctx, { ...req, prompt });
  if (isInterrupt(outcome)) return { status: "interrupted", message: `sketch interrupted (${outcome.errorKind ?? "aborted"})` };
  await commitAll(runner, w, `sketch v${version}`);
  if (outcome.errorKind) return { status: "failed", message: `sketch run failed: ${outcome.errorKind}` };

  const check = () => {
    const r = extractJson(run.resultText, SketchSchema);
    if (!r.ok) return r;
    const files = [...r.value.screens.map((s) => s.file), ...r.value.directions.flatMap((d) => d.screens)];
    const missing = files.filter((f) => !existsSync(join(project.repoPath, dir, f)));
    return missing.length ? { ok: false as const, error: `screenshots missing in ${dir}/: ${missing.join(", ")}` } : r;
  };
  let parsed = check();
  if (!parsed.ok && run.sessionId) {
    ({ run, outcome } = await builderRun(deps, project, w, ctx, { ...req, prompt: `The sketch cannot be shown yet: ${parsed.error}\nFix this, then end with the ${JSON_OPEN} … ${JSON_CLOSE} block.` }));
    if (isInterrupt(outcome)) return { status: "interrupted", message: "sketch interrupted during correction" };
    await commitAll(runner, w, `sketch v${version}: fixes`);
    parsed = check();
  }
  if (!parsed.ok) {
    markRunParseError(db, run.id, parsed.error);
    return { status: "failed", message: `sketch unusable: ${parsed.error}` };
  }

  const s = normalizeSketch(parsed.value);
  if (s.nothing_to_show) {
    const row = db.insert(sketches).values({ projectId: project.id, version, status: "skipped", summary: s, runId: run.id }).returning().get();
    logEvent(db, project.id, "sketch_skipped", { reason: "nothing to show", version, size: s.scope.size });
    const next = await concludeSketch(deps, getProject(db, project.id), row);
    return { status: "progressed", message: `nothing to sketch (${s.scope.size}) — continuing with ${next}` };
  }
  db.insert(sketches).values({ projectId: project.id, version, status: "ready", summary: s, runId: run.id }).run();
  logEvent(db, project.id, "sketch_ready", { version, screens: s.screens.length, directions: s.directions.length, size: s.scope.size, risk: s.scope.risk });
  applyProjectEvent(db, getProject(db, project.id), { type: "sketch_ready" });
  return { status: "progressed", message: `sketch v${version} ready${s.directions.length ? ` (${s.directions.length} directions)` : ""} — waiting for the owner` };
}

function goalsText(project: Project): string {
  const g = join(project.repoPath, docPaths(project).goals);
  return project.mode !== "scratch" && existsSync(g) ? `\n## What the owner chose to do\n\n${readFileSync(g, "utf8").replace(/^# .*\n/, "")}\n` : "";
}

function whereText(project: Project): string {
  if (project.mode === "scratch") {
    return "A new, empty project folder. Pick a boring, well-known stack that fits the brief, with **today's** versions (check `node --version` and `npm view <package> version`, do not rely on memory), and make the smallest app that shows the main screen.";
  }
  return `An existing repository (the owner's work; see the brief). Look at it **quickly** (2–3 minutes: how it runs, the main screen, the components and styles it uses), not a full study. Reuse its components and styles in the sketch.`;
}

// ─────────────────────────── after the agreement ───────────────────────────

/**
 * The sketch is agreed (or there was nothing to show): write what the next
 * stage needs and move on. Big work (L/XL) gets the full architecture or
 * map; everything else goes straight to the plan with a short document made
 * from the sketch. Returns the next status.
 */
export async function concludeSketch(deps: LoopDeps, project: Project, row: Sketch): Promise<"mapping" | "architecting" | "planning"> {
  const { db, runner } = deps;
  const d = docPaths(project);
  const s = row.summary;
  const big = s.scope.size === "L" || s.scope.size === "XL";
  const mapped = project.mode !== "scratch" && !!db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.projectId, project.id), eq(decisions.target, "architecture"), eq(decisions.kind, "approve"))).get();
  const next = mapped ? "planning" : big ? (project.mode === "scratch" ? "architecting" : "mapping") : "planning";

  const w = ws(project);
  await checkoutBranch(runner, w, project.integrationBranch, baseOf(project));
  if (row.status !== "skipped") await extractSketchCode(deps, project);
  mkdirSync(join(project.repoPath, d.dir), { recursive: true });
  if (next === "planning" && !mapped) {
    writeFileSync(join(project.repoPath, d.arch), sketchArchDoc(project, row));
    if (project.mode === "scratch") {
      writeFileSync(join(project.repoPath, d.archJson), JSON.stringify({ stack: s.stack, external_services: [], verify_commands: s.verify_commands, risks: [], open_questions: [] }, null, 2) + "\n");
    }
  }
  if (project.mode !== "scratch") {
    const goals = join(project.repoPath, d.goals);
    const before = existsSync(goals) ? readFileSync(goals, "utf8").trimEnd() + "\n\n" : "# Goals\n\n";
    writeFileSync(goals, `${before}${agreementSection(db, project, row)}\n`);
  }
  await commitPaths(runner, w, [d.dir], row.status === "skipped" ? "aipm: scope from the sketch step" : `aipm: the owner agreed on sketch v${row.version}`);
  applyProjectEvent(db, getProject(db, project.id), { type: "sketch_done", next });
  logEvent(db, project.id, "sketch_concluded", { version: row.version, next, size: s.scope.size });
  return next;
}

/** Copy the files the sketch changed into .orys/sketch/code/ (git-excluded), so later agents can read them without git. */
async function extractSketchCode(deps: LoopDeps, project: Project): Promise<void> {
  const w = ws(project);
  const branch = sketchBranch(project);
  const base = (await deps.runner.exec(w, `git merge-base ${shq(baseOf(project))} ${shq(branch)}`, { timeoutMs: 30_000 })).outputTail.trim();
  if (!base) return;
  const files = (await deps.runner.exec(w, `git diff --name-only --diff-filter=AM ${shq(base)} ${shq(branch)}`, { timeoutMs: 30_000, tailLines: 2_000 })).outputTail.split("\n").filter(Boolean);
  if (!files.length) return;
  mkdirSync(join(project.repoPath, SKETCH_CODE_DIR), { recursive: true });
  await deps.runner.exec(w, `git archive ${shq(branch)} -- ${files.slice(0, 400).map(shq).join(" ")} | tar -x -C ${shq(SKETCH_CODE_DIR)}`, { timeoutMs: 60_000 });
}

function sketchArchDoc(project: Project, row: Sketch): string {
  const s = row.summary;
  const title = project.mode === "scratch" ? "Architecture (from the agreed sketch)" : "Repository notes (from the agreed sketch)";
  return [
    `# ${title}`,
    "",
    `> No separate ${project.mode === "scratch" ? "architecture" : "mapping"} step: the work is ${s.scope.size} with ${s.scope.risk} risk, and the owner agreed on sketch v${row.version}. Build what the sketch shows, properly.`,
    "",
    "## Stack",
    bullets(s.stack),
    "",
    "## How to run",
    s.how_to_run || "_(see the project's README)_",
    "",
    "## Verify commands (as the sketch found them)",
    bullets(s.verify_commands.map((c) => `\`${c}\``)),
    "",
    "## What the sketch showed",
    s.summary_plain,
    "",
    "### Real in the sketch",
    bullets(s.what_is_real),
    "",
    "### Faked in the sketch (must be built for real)",
    bullets(s.what_is_faked),
    "",
    ...(project.mode === "scratch" ? [] : ["### No longer shown (the owner agreed)", bullets(noLongerShown(row), "_(nothing: everything the owner sees today stays)_"), ""]),
    "## Sketch code",
    `Branch \`${sketchBranch(project)}\`; the files it changed are copied to \`${SKETCH_CODE_DIR}/\` for reference. It cuts corners: rebuild properly, reuse what is sound.`,
    "",
  ].join("\n");
}

function agreementSection(db: DbOrTx, project: Project, row: Sketch): string {
  if (row.status === "skipped") return `## Scope (sketch step)\n\nNothing to show before building: ${row.summary.scope.reason}\n`;
  const notes = listSketches(db, project.id).filter((x) => x.feedback).map((x) => `v${x.version}: ${x.feedback}`);
  return [
    `## Agreed on sketch v${row.version}${row.direction ? ` (direction "${row.direction}")` : ""}`,
    "",
    row.summary.summary_plain,
    "",
    `No longer shown (agreed): ${noLongerShown(row).join("; ") || "nothing, everything the owner sees today stays"}.`,
    "",
    notes.length ? `The owner's reactions on the way:\n${bullets(notes)}\n` : "",
  ].join("\n");
}

/** The exact files of the sketch's code copy: agents must not guess paths (first real run: 4 of 7 tasks had wrong ones). */
function sketchCodeList(project: Project): string {
  const root = join(project.repoPath, SKETCH_CODE_DIR);
  if (!existsSync(root)) return "";
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else files.push(`${SKETCH_CODE_DIR}/${r}`);
    }
  };
  walk(root, "");
  if (!files.length) return "";
  const shown = files.sort().slice(0, 40);
  return `\nSketch code for reference (it cuts corners; use these exact paths):\n${bullets(shown.map((f) => `\`${f}\``))}${files.length > shown.length ? `\n- … and ${files.length - shown.length} more` : ""}`;
}

/** The agreed sketch for planner, architect, worker, reviewer and handoff prompts ("" when there is none). */
export function sketchForPrompt(db: DbOrTx, project: Project, audience: "planner" | "worker" | "handoff"): string {
  const row = agreedSketch(db, project.id);
  if (!row || row.status === "skipped") return "";
  const s = row.summary;
  const dir = sketchDir(row.version);
  const notes = listSketches(db, project.id).filter((x) => x.feedback).map((x) => `v${x.version}: ${x.feedback}`);
  const dirInfo = row.direction ? normalizeSketch(s).directions.find((d) => d.id === row.direction) : undefined;
  const rule = {
    planner: "Plan the build of **what this sketch shows** — same screens, layout and behaviour — done properly: real data instead of the faked parts, tests, the project's structure. The outcome must promise what the sketch shows; anything you would do differently from the sketch goes into `open_questions`.",
    worker: "For anything people see, match the sketch's layout and behaviour; build it properly (real data, tests).",
    handoff: "Compare what was built with this sketch: the owner agreed on it, so it is part of the promise.",
  }[audience];
  const gone = noLongerShown(row);
  const keep = {
    planner: "Everything else the owner sees today stays, also where the rough sketch does not draw it: plan for it in the new layout. Promise only these removals; any other removal you think is needed goes into `open_questions`.",
    worker: "Do not remove anything the owner sees today (numbers, fields, buttons, sections, links) unless it is in this list. Where the sketch does not draw something that exists today, keep it in the new layout.",
    handoff: "Anything the owner could see before that is gone now and is not in this list is a broken promise: report it as `partial` or in `known_gaps`.",
  }[audience];
  const removal = project.mode === "scratch" ? "" : `\n${gone.length ? `The owner agreed that these will **no longer be shown**:\n${bullets(gone)}` : "The owner agreed to **no removals**: nothing they see today goes away."}\n${keep}`;
  return [
    "",
    `## The sketch the owner agreed on (v${row.version})`,
    "",
    s.summary_plain,
    dirInfo ? `\nChosen direction: **${dirInfo.title}** — ${dirInfo.idea}` : "",
    "",
    "Screenshots (open them with Read):",
    bullets(sketchScreens(row).map((x) => `\`${dir}/${x.file}\`${x.caption ? ` — ${x.caption}` : ""}`)),
    ...(s.demo.length ? ["", "Demo:", ...s.demo.map((x) => `\`${x.command}\` →\n\`\`\`\n${x.output}\n\`\`\``)] : []),
    s.what_is_faked.length ? `\nFaked in the sketch: ${s.what_is_faked.join("; ")}` : "",
    removal,
    notes.length ? `\nThe owner's reactions on the way:\n${bullets(notes)}` : "",
    audience !== "handoff" ? sketchCodeList(project) : "",
    "",
    rule,
    "",
  ].join("\n");
}

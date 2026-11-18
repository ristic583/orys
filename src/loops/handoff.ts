/**
 * Handoff (SPEC §22.2 #5–6): when the last phase is merged, an independent
 * agent checks the promises made before building against what was built and
 * writes the owner a plain note: what they can see now, how, what is missing.
 * The owner then accepts the result or sends it back (projects/outcome.ts).
 */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { decidedAnswers, HandoffSchema, type Handoff } from "../core/outcome.js";
import type { DbOrTx } from "../db/index.js";
import { events, phases, projects, runs, tasks, verifications, type Project } from "../db/schema.js";
import { shq } from "../git/index.js";
import { briefVars } from "../projects/brief.js";
import { docPaths } from "../projects/docs.js";
import { listFeatures, logEvent } from "../projects/repo.js";
import { bullets, renderPrompt } from "../prompts/render.js";
import { recordClaudeRun } from "../runs/recorder.js";
import { READ_ONLY_TOOLS, isInterrupt, isSandbox, markRunParseError, roleOf, ws, type LoopDeps, type StepResult } from "./common.js";
import { SCREENS_DIR } from "./execution.js";
import { sketchForPrompt } from "./sketch.js";

/** Screenshots in the project, newest names last (they are named by task key). */
export function listScreens(project: Project): string[] {
  const dir = join(project.repoPath, SCREENS_DIR);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : [];
}

/**
 * What the gate ran, per command. The handoff agent cannot run anything
 * itself; without this it told the owner the tests "were not run" (first
 * sketch-first run) although the gate had run them 22 times, all green.
 */
export function gateChecks(db: DbOrTx, projectId: string): string {
  const rows = db
    .select({ command: verifications.command, exitCode: verifications.exitCode, key: tasks.key })
    .from(verifications)
    .innerJoin(tasks, eq(tasks.id, verifications.taskId))
    .innerJoin(phases, eq(phases.id, tasks.phaseId))
    .where(and(eq(phases.projectId, projectId), eq(verifications.baseline, false)))
    .orderBy(asc(verifications.createdAt), asc(verifications.id))
    .all();
  if (!rows.length) return "- _(no automatic checks were recorded for this project)_";
  const by = new Map<string, { runs: number; passed: number; last: number; lastTask: string }>();
  for (const r of rows) {
    const c = by.get(r.command) ?? { runs: 0, passed: 0, last: 0, lastTask: "" };
    c.runs++;
    if (r.exitCode === 0) c.passed++;
    c.last = r.exitCode;
    c.lastTask = r.key;
    by.set(r.command, c);
  }
  const lines = [...by].slice(0, 24).map(([cmd, c]) => `\`${cmd}\` — ran ${c.runs}×, passed ${c.passed}×; last run (task ${c.lastTask}): ${c.last === 0 ? "passed" : `**failed** (exit ${c.last})`}`);
  return bullets(by.size > lines.length ? [...lines, `… and ${by.size - lines.length} more commands`] : lines);
}

/** A handoff built from what Orys knows, when the agent could not write one. */
function fallbackHandoff(project: Project, done: string[]): Handoff {
  return {
    summary_plain: `All phases are finished and merged into ${project.integrationBranch}. The automatic check of the promises did not work, so look at the result yourself.`,
    delivered: (project.outcome?.you_will_see ?? []).map((s) => ({ promise: `${s.where}: ${s.what}`, status: "partial" as const, note: "not checked" })),
    how_to_see: [isSandbox(project) ? `Open the copy at ${project.repoPath}` : `Look at branch ${project.integrationBranch} in ${project.repoPath}`],
    known_gaps: done.length ? [] : ["No task was finished."],
  };
}

/**
 * Write the handoff. Returns a step result while it is pending (interrupted,
 * failed), or null once `projects.handoff` is set and the project can finish.
 */
export async function handoffStep(deps: LoopDeps, project: Project): Promise<StepResult | null> {
  const { db, runner, config } = deps;
  const d = docPaths(project);
  const ph = db.select().from(phases).where(eq(phases.projectId, project.id)).orderBy(asc(phases.idx)).all();
  const done = ph.length ? db.select({ title: tasks.title }).from(tasks).where(and(inArray(tasks.phaseId, ph.map((p) => p.id)), eq(tasks.status, "done"))).all().map((t) => t.title) : [];
  const screens = listScreens(project);
  const save = (h: Handoff) => {
    db.update(projects).set({ handoff: { ...h, screenshots: screens.slice(-16), at: new Date().toISOString() }, accepted: null }).where(eq(projects.id, project.id)).run();
    logEvent(db, project.id, "handoff_ready", { delivered: h.delivered.length, missing: h.delivered.filter((x) => x.status !== "done").length });
  };

  // Give up after two broken tries since the last return: a plain handoff is better than a stuck project.
  const lastReturn = db.select({ id: events.id }).from(events).where(and(eq(events.projectId, project.id), eq(events.type, "handoff_returned"))).orderBy(desc(events.id)).get()?.id ?? "";
  const failures = db.select({ id: runs.id }).from(runs).where(and(eq(runs.projectId, project.id), eq(runs.kind, "handoff"), inArray(runs.errorKind, ["crash", "timeout", "parse"]), gt(runs.id, lastReturn))).all().length;
  if (failures >= 2) {
    save(fallbackHandoff(project, done));
    return null;
  }

  const base = project.baseBranch ?? (await runner.exec(ws(project), "git rev-list --max-parents=0 HEAD | tail -n 1", { timeoutMs: 30_000 })).outputTail.trim();
  const stat = await runner.exec(ws(project), `git diff --stat ${shq(base)} ${shq(project.integrationBranch)} | tail -n 60`, { timeoutMs: 60_000, tailLines: 80 });
  const o = project.outcome;
  const returned = db.select({ payload: events.payload }).from(events).where(and(eq(events.projectId, project.id), eq(events.type, "handoff_returned"))).orderBy(asc(events.id)).all();
  const role = roleOf(project, "reviewer");
  const prompt = renderPrompt("handoff", {
    ...briefVars(project, listFeatures(db, project.id)),
    summary: o?.summary_plain ?? "_(this project was planned before promises were recorded; describe what was built)_",
    you_will_see: bullets((o?.you_will_see ?? []).map((s) => `${s.where}: ${s.what}`)),
    stays_the_same: bullets(o?.stays_the_same ?? []),
    decisions: bullets([...decidedAnswers(o).map((a) => `${a.question} → ${a.answer}`), ...(project.designChoice ? [`Design direction: "${project.designChoice.title}" (${project.designChoice.file})`] : [])]),
    sketch: sketchForPrompt(db, project, "handoff"),
    returned: returned.length ? `\nThe owner sent an earlier result back; these notes must be addressed too:\n${bullets(returned.map((r) => String(r.payload.note ?? "")))}\n` : "",
    phases: bullets(ph.map((p) => `${p.title}: ${p.goalPlain ?? p.goal}`)),
    diff_stat: stat.outputTail.trim() || "(no changes)",
    state_doc: d.state,
    screenshots: bullets(screens.map((f) => `\`${SCREENS_DIR}/${f}\``)),
    checks: gateChecks(db, project.id),
    how_to_see_hint: isSandbox(project)
      ? `This was test mode: everything is in the copy at \`${project.repoPath}\` (branch \`${project.integrationBranch}\`); the owner's original is untouched. Say how to run the copy, and that bringing it into the real repo is a separate step.`
      : project.baseBranch
        ? `The work is on branch \`${project.integrationBranch}\`; the owner's \`${project.baseBranch}\` is unchanged until they merge.`
        : "Use the project's own run commands (see the README or docs).",
    summary_language: config.AIPM_SUMMARY_LANGUAGE,
  });
  const req = { model: role.model, effort: role.effort, disallowedTools: READ_ONLY_TOOLS, timeoutMs: config.timeouts.handoff };
  const ctx = { kind: "handoff" as const, projectId: project.id };
  let { run, outcome } = await recordClaudeRun(deps, ws(project), ctx, { ...req, prompt });
  if (isInterrupt(outcome)) return { status: "interrupted", message: `handoff interrupted (${outcome.errorKind ?? "aborted"})` };
  if (outcome.errorKind) return { status: "failed", message: `handoff run failed: ${outcome.errorKind}` };
  let parsed = extractJson(run.resultText, HandoffSchema);
  if (!parsed.ok && run.sessionId) {
    ({ run, outcome } = await recordClaudeRun(deps, ws(project), ctx, { ...req, resumeSessionId: run.sessionId, prompt: `Your answer could not be used: ${parsed.error}\nReply again with only the ${JSON_OPEN} … ${JSON_CLOSE} block.` }));
    if (isInterrupt(outcome)) return { status: "interrupted", message: "handoff interrupted during correction" };
    parsed = extractJson(run.resultText, HandoffSchema);
  }
  if (!parsed.ok) {
    markRunParseError(db, run.id, parsed.error);
    return { status: "failed", message: "handoff note unusable" };
  }
  save(parsed.value);
  return null;
}

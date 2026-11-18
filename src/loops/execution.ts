/**
 * Loop 3 (SPEC §7.3–7.5): worker → verify → (task review) → … → phase review
 * → merge. `advanceExecution` performs one step and can be called again after
 * any interruption; all state lives in the database and the project repo.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { resolveWorker } from "../core/profiles.js";
import { phaseComplete, tasksToRelease, transitionPhase, transitionTask, type PhaseEvent, type TaskEvent } from "../core/stateMachines.js";
import type { Db, DbOrTx } from "../db/index.js";
import { decisions, phases, runs, sessionSlots, tasks, verifications, type Phase, type Project, type Run, type Task } from "../db/schema.js";
import { atRevision, changedSince, checkoutBranch, commitAll, diffForReview, headSha, isDirty, mergeBranch } from "../git/index.js";
import { applyProjectEvent, getProject, listFeatures, logEvent } from "../projects/repo.js";
import { bullets, renderPrompt } from "../prompts/render.js";
import { recordClaudeRun } from "../runs/recorder.js";
import { claimSlot, releaseSlot, rotateIfTooLarge } from "../sessions/slots.js";
import { docPaths } from "../projects/docs.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalExclude } from "../git/index.js";
import { decidedAnswers } from "../core/outcome.js";
import { designBrief } from "./design.js";
import { handoffStep } from "./handoff.js";
import { sketchForPrompt } from "./sketch.js";
import { NO_GIT, builderRun, isInterrupt, isSandbox, profileOf, roleOf, truncate, workerFor, ws, type LoopDeps, type StepResult } from "./common.js";
import { runReview } from "./review.js";

const VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Verify commands at least this slow are named in the worker prompt, so it runs them once instead of in a loop. */
const SLOW_CHECK_MS = 30_000;
/** Where workers save UI screenshots, relative to the repo; excluded from git, read by the reviewer. */
export const SCREENS_DIR = ".orys/screens";
/** First line of a task's feedback when its gate failure also happens on the base commit. */
export const DISPUTE_MARK = "PRE-EXISTING GATE FAILURE";
/** Workers may use git, but never push. */
const WORKER_DISALLOWED = ["Bash(git push:*)"];

// ─────────────────────────── persistence helpers ───────────────────────────

function phaseTasks(db: DbOrTx, phaseId: string): Task[] {
  return db.select().from(tasks).where(eq(tasks.phaseId, phaseId)).orderBy(asc(tasks.idx)).all();
}

function applyTask(db: DbOrTx, task: Task, e: TaskEvent, extra: Partial<Task> = {}): Task {
  const next = transitionTask(
    { status: task.status, attempts: task.attempts, maxAttempts: task.maxAttempts, sessionId: task.sessionId, lastFeedback: task.lastFeedback },
    e,
  );
  const row = db.update(tasks).set({ ...next, ...extra }).where(eq(tasks.id, task.id)).returning().get();
  if (row.status !== task.status) {
    const projectId = db.select({ p: phases.projectId }).from(phases).where(eq(phases.id, task.phaseId)).get()?.p ?? null;
    logEvent(db, projectId, "task_status", { taskId: task.id, key: task.key, from: task.status, to: row.status, event: e.type });
  }
  return row;
}

function applyPhase(db: DbOrTx, phase: Phase, e: PhaseEvent): Phase {
  const status = transitionPhase(phase.status, e);
  const row = db.update(phases).set({ status }).where(eq(phases.id, phase.id)).returning().get();
  logEvent(db, phase.projectId, "phase_status", { phaseId: phase.id, idx: phase.idx, from: phase.status, to: status, event: e.type });
  return row;
}

/** Release pending tasks of a phase whose dependencies (in any phase) are done or skipped. */
function releaseReady(db: DbOrTx, project: Project, phase: Phase): number {
  const all = db.select({ id: tasks.id, status: tasks.status, dependsOn: tasks.dependsOn, phaseId: tasks.phaseId }).from(tasks).innerJoin(phases, eq(tasks.phaseId, phases.id)).where(eq(phases.projectId, project.id)).all();
  const released = tasksToRelease(all).filter((t) => t.phaseId === phase.id);
  for (const t of released) db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, t.id)).run();
  return released.length;
}

/**
 * On app start (SPEC §9): runs that never ended belonged to a process that is
 * gone, so close them; a worker that was `running` → `interrupted` (resumable,
 * no attempt used), keeping the session id the recorder saved early.
 * `verifying`/`reviewing` are idempotent and simply resume.
 */
export function recoverInFlight(db: Db, now = new Date()): number {
  return db.transaction((tx) => {
    const dangling = tx.update(runs).set({ endedAt: now, isError: true, resultText: "[interrupted: Orys stopped during this run]" }).where(isNull(runs.endedAt)).returning().all();
    const recovered = tx.select().from(tasks).where(eq(tasks.status, "running")).all();
    for (const t of recovered) {
      const sessionId = t.sessionId ?? dangling.filter((r) => r.taskId === t.id && r.kind === "worker" && r.sessionId).sort((a, b) => a.id.localeCompare(b.id)).at(-1)?.sessionId ?? null;
      tx.update(tasks).set({ status: "interrupted", sessionId }).where(eq(tasks.id, t.id)).run();
      logEvent(tx, null, "task_recovered", { taskId: t.id, key: t.key, sessionId });
    }
    keepLatestSession(tx, dangling);
    return recovered.length;
  });
}

/** A builder run that never ended still extended its project's session: the next run continues from there. */
function keepLatestSession(tx: DbOrTx, dangling: Run[]): void {
  const builders = dangling.filter((r) => r.projectId && r.sessionId && BUILDER_KINDS.includes(r.kind)).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of builders) tx.update(sessionSlots).set({ sessionId: r.sessionId }).where(eq(sessionSlots.projectId, r.projectId!)).run();
}
const BUILDER_KINDS: Run["kind"][] = ["mapper", "architect", "planner", "worker"];

/** Like `recoverInFlight`, for one project only (its step failed; other projects keep running). */
export function recoverProject(db: Db, projectId: string, now = new Date()): number {
  return db.transaction((tx) => {
    const dangling = tx.update(runs).set({ endedAt: now, isError: true, resultText: "[interrupted: the step failed during this run]" }).where(and(isNull(runs.endedAt), eq(runs.projectId, projectId))).returning().all();
    keepLatestSession(tx, dangling);
    const recovered = tx.select({ t: tasks }).from(tasks).innerJoin(phases, eq(tasks.phaseId, phases.id)).where(and(eq(phases.projectId, projectId), eq(tasks.status, "running"))).all().map((r) => r.t);
    for (const t of recovered) {
      tx.update(tasks).set({ status: "interrupted" }).where(eq(tasks.id, t.id)).run();
      logEvent(tx, projectId, "task_recovered", { taskId: t.id, key: t.key, sessionId: t.sessionId });
    }
    return recovered.length;
  });
}

function doneCount(db: DbOrTx, projectId: string): number {
  return db.select({ id: tasks.id }).from(tasks).innerJoin(phases, eq(tasks.phaseId, phases.id)).where(and(eq(phases.projectId, projectId), eq(tasks.status, "done"))).all().length;
}

/** Non-blocking notes reviewers attached to approvals; forwarded to workers so they are not lost. */
function reviewerNotes(db: DbOrTx, projectId: string, limit = 8): string {
  const rows = db
    .select({ target: decisions.target, feedback: decisions.feedback })
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.kind, "approve"), isNotNull(decisions.runId), ne(decisions.feedback, "")))
    .orderBy(desc(decisions.id))
    .limit(limit)
    .all();
  return bullets(rows.map((r) => `(${r.target}) ${r.feedback.replace(/\s*\n\s*/g, " ")}`));
}

// ─────────────────────────── main step ───────────────────────────

export async function advanceExecution(deps: LoopDeps, projectId: string): Promise<StepResult> {
  const { db } = deps;
  rotateIfTooLarge(db, projectId, deps.config.AIPM_SESSION_MAX_CONTEXT);
  const project = getProject(db, projectId);
  if (project.paused) return { status: "idle", message: "project is paused" };
  if (project.status !== "executing") return { status: "idle", message: `project is ${project.status}` };

  const all = db.select().from(phases).where(eq(phases.projectId, project.id)).orderBy(asc(phases.idx)).all();
  let phase = all.find((p) => p.status === "active" || p.status === "reviewing" || p.status === "blocked");
  if (!phase) {
    const next = all.find((p) => p.status === "pending");
    if (!next) {
      // Hand the result over before finishing: what was promised vs built, how to see it.
      if (!project.handoff) {
        const pending = await handoffStep(deps, project);
        if (pending) return pending;
      }
      applyProjectEvent(db, getProject(db, project.id), { type: "all_phases_done" });
      releaseSlot(db, project.id, "done"); // the session stays resumable from the event log
      return { status: "progressed", message: "all phases done — project complete" };
    }
    phase = db.transaction((tx) => {
      const activated = applyPhase(tx, next, { type: "activate" });
      releaseReady(tx, project, activated);
      return activated;
    });
  }
  if (phase.status === "blocked") return { status: "blocked", message: `phase ${phase.idx} is blocked` };
  if (phase.status === "reviewing") return phaseReviewStep(deps, project, phase);

  releaseReady(db, project, phase);
  const list = phaseTasks(db, phase.id);
  // A gate or review that was cut short (limit, restart) resumes without re-running the worker.
  const midway = list.find((t) => t.status === "verifying" || t.status === "reviewing");
  if (midway) return midway.status === "verifying" ? verifyAndReview(deps, project, phase, midway) : reviewTask(deps, project, phase, midway, "_(passed earlier)_");
  const order = ["interrupted", "rework", "ready"] as const;
  const task = order.map((s) => list.find((t) => t.status === s)).find(Boolean);
  if (task) return taskStep(deps, project, phase, task);

  if (phaseComplete(list)) {
    applyPhase(db, phase, { type: "all_tasks_done" });
    return { status: "progressed", message: `phase ${phase.idx} tasks complete → phase review` };
  }
  const stuck = list.find((t) => t.status === "failed" || t.status === "escalated");
  if (stuck) {
    const p = getProject(db, project.id);
    if (p.status !== "blocked") applyProjectEvent(db, p, { type: "block", reason: `Task ${stuck.key} is ${stuck.status}: ${stuck.lastFeedback ?? ""}`.slice(0, 1_000) });
    return { status: "blocked", message: `task ${stuck.key} ${stuck.status}` };
  }
  return { status: "idle", message: `phase ${phase.idx}: no runnable task` };
}

// ─────────────────────────── task ───────────────────────────

async function taskStep(deps: LoopDeps, project: Project, phase: Phase, task: Task): Promise<StepResult> {
  const { db, runner, config } = deps;
  const w = ws(project);
  const profile = profileOf(project);

  await checkoutBranch(runner, w, phase.branch, project.integrationBranch);
  ensureLocalExclude(project.repoPath, ".orys/");
  if (await isDirty(runner, w)) {
    // Leftovers of an interrupted session: keep them, the resumed worker continues from there.
    await commitAll(runner, w, `wip(${task.key}): partial work before resume`);
  }
  const baseSha = task.baseSha ?? (await headSha(runner, w));
  const continuing = !!task.sessionId && (task.status === "interrupted" || task.status === "rework");
  // The project session carries the task's context only if it was not rotated since.
  const resumable = continuing ? (claimSlot(db, project).sessionId ?? undefined) : undefined;
  task = applyTask(db, task, { type: "start" }, { baseSha });

  const worker = workerFor(project, task);
  const prompt = resumable ? resumePrompt(task) : fullWorkerPrompt(db, project, phase, task);
  const { run, outcome } = await builderRun(
    deps,
    project,
    w,
    { kind: "worker", projectId: project.id, phaseId: phase.id, taskId: task.id },
    {
      prompt,
      model: worker.model,
      effort: worker.effort,
      permissionMode: project.workerPermissionMode,
      resumeSessionId: resumable,
      disallowedTools: isSandbox(project) ? NO_GIT : WORKER_DISALLOWED,
      timeoutMs: config.timeouts.worker,
    },
  );

  if (isInterrupt(outcome)) {
    applyTask(db, task, { type: "interrupt", sessionId: run.sessionId ?? undefined });
    return { status: "interrupted", message: `task ${task.key} interrupted (${outcome.errorKind ?? "aborted"})` };
  }
  await commitAll(runner, w, `task(${task.key}): ${task.title}`);
  if (outcome.errorKind) {
    const t = applyTask(db, task, { type: "worker_failed", sessionId: run.sessionId ?? undefined, feedback: `The previous session ended with ${outcome.errorKind}. Check the current state of the repository and finish the task.` });
    return t.status === "failed" ? blockOnTask(deps, project, t) : { status: "progressed", message: `task ${task.key}: worker ${outcome.errorKind}, will retry` };
  }
  task = applyTask(db, task, { type: "worker_finished", sessionId: run.sessionId ?? task.sessionId ?? "" });
  return verifyAndReview(deps, project, phase, task, run.id);
}

/** Gate: master code runs the verify commands, not the worker. Then review (if the profile wants it). */
async function verifyAndReview(deps: LoopDeps, project: Project, phase: Phase, task: Task, runId?: string): Promise<StepResult> {
  const { db } = deps;
  await checkoutBranch(deps.runner, ws(project), phase.branch, project.integrationBranch);
  const verify = await runVerify(deps, project, task.verifyCommands, { taskId: task.id, runId });
  if (!verify.ok) {
    // Red before the task too? Then it is not (only) the worker's doing: the reviewer decides, no attempt is used.
    const w = ws(project);
    const base = task.baseSha && (await changedSince(deps.runner, w, task.baseSha))
      ? await baselineCheck(deps, project, task.verifyCommands, verify, task.baseSha, phase.branch, task.id)
      : null;
    if (base?.red) {
      logEvent(db, project.id, "gate_red_on_base", { taskId: task.id, key: task.key, command: verify.failed, base: task.baseSha });
      const t = applyTask(db, task, { type: "verify_disputed", feedback: disputeText(verify, base, `the commit before this task (${task.baseSha!.slice(0, 10)})`) });
      return reviewTask(deps, project, phase, t, t.lastFeedback!);
    }
    const t = applyTask(db, task, { type: "verify_failed", feedback: verify.feedback });
    return t.status === "failed" ? blockOnTask(deps, project, t) : { status: "progressed", message: `task ${task.key}: verification failed (${verify.failed}), rework` };
  }
  const reviewRequired = task.review === "always" ? true : task.review === "never" ? false : profileOf(project).reviewPerTask;
  task = applyTask(db, task, { type: "verify_passed", reviewRequired });
  if (task.status === "done") return finishTask(deps, project, phase, task);
  return reviewTask(deps, project, phase, task, verify.summary);
}

async function reviewTask(deps: LoopDeps, project: Project, phase: Phase, task: Task, verifySummary: string): Promise<StepResult> {
  const { db, runner, config } = deps;
  const disputed = !!task.lastFeedback?.startsWith(DISPUTE_MARK);
  const gate = disputed ? task.lastFeedback! : verifySummary;
  const diff = await diffForReview(runner, ws(project), task.baseSha!, "HEAD", config.AIPM_REVIEW_DIFF_MAX_LINES);
  const review = await runReview(deps, {
    project,
    features: listFeatures(db, project.id),
    target: "task",
    phaseId: phase.id,
    taskId: task.id,
    subject: [
      `**Task \`${task.key}\`: ${task.title}** (phase ${phase.idx}: ${phase.title})`,
      "",
      "#### Spec",
      task.spec,
      "",
      "#### Acceptance criteria",
      bullets(task.acceptance),
      "",
      disputed ? "#### Verify gate (run by the system): FAILED, but it fails before this task too" : "#### Verify gate (run by the system): passed",
      gate,
      "",
      workerReport(db, task.id),
      designBrief(project),
      sketchForPrompt(db, project, "worker"),
      screenshots(project, [task.key]),
      diff,
    ].join("\n"),
    guidance: [
      ...(disputed ? DISPUTE_GUIDANCE : []),
      "- Does the change meet every acceptance criterion? Do the tests actually exercise them?",
      "- Bugs, unhandled edge cases, security problems (input validation, injection, secrets)?",
      "- Was the gate weakened (skipped tests, loosened config, edited verify scripts)? That is always rework.",
      `- Does it follow ${docPaths(project).arch} and stay within the task's scope?`,
      "- Minor style issues are not a reason for rework; mention them as notes.",
    ].join("\n"),
  });
  // Interrupted or unusable review: the task stays in `reviewing` and the next step retries the review.
  if (review.kind !== "decided") return { status: review.kind === "interrupted" ? "interrupted" : "failed", message: review.message };
  const d = review.decision;
  const feedback = [d.feedback || d.rationale, disputed && d.kind === "rework" ? `\n${gate}` : ""].join("");
  const t = applyTask(db, task, { type: "review", decision: d.kind, feedback });
  if (disputed && t.status === "done") logEvent(db, project.id, "gate_failure_accepted", { taskId: task.id, key: task.key });
  if (t.status === "done") return finishTask(deps, project, phase, t);
  if (t.status === "escalated" || t.status === "failed") return blockOnTask(deps, project, t);
  return { status: "progressed", message: `task ${task.key}: review asked for rework` };
}

const DISPUTE_GUIDANCE = [
  "- **The gate failed**, but the same command also fails on the code before this work (output of both runs above). Decide whose problem it is:",
  "  - **approve** if the remaining failure was already there, lies outside this work's scope, and the work itself is sound. Say in `feedback` what is still red, so the owner knows.",
  "  - **rework** if this work should have fixed it (it is in scope) or made it worse (new failures, more failing tests).",
  "  - **escalate** if the gate cannot pass without the owner (broken environment, a test someone else must fix, a verify command that should change).",
];

/** Gate output for the reviewer and the worker when the failing command also fails on the base commit. */
function disputeText(verify: Extract<VerifyResult, { ok: false }>, base: BaselineResult, where: string): string {
  return [
    DISPUTE_MARK,
    "",
    `\`${verify.failed}\` fails after this work, and it also fails on ${where}.`,
    "",
    "After this work (last lines):",
    "```",
    truncate(verify.outputTail, 6_000),
    "```",
    "",
    `On ${where} (last lines):`,
    "```",
    truncate(base.outputTail, 6_000),
    "```",
  ].join("\n");
}

/** Screenshots the workers took for these tasks, for the reviewer to open. */
function screenshots(project: Project, keys: string[]): string {
  const dir = join(project.repoPath, SCREENS_DIR);
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.endsWith(".png") && keys.some((k) => f.startsWith(`${k}-`))).sort();
  if (!files.length) return "";
  return [
    "#### Screenshots taken by the worker",
    "Open each one with Read and judge what the owner will see against the spec: layout and structure, not only colors; overflow, unreadable text, controls that do not match the rest.",
    ...files.map((f) => `- \`${SCREENS_DIR}/${f}\``),
    "",
  ].join("\n");
}

const WorkerReportSchema = z.object({ summary: z.string().default(""), notes_for_reviewer: z.string().default("") });

/** What the worker said about its own work (summary and notes for the reviewer), from its latest run. */
function workerReport(db: DbOrTx, taskId: string): string {
  const run = db.select({ text: runs.resultText }).from(runs).where(and(eq(runs.taskId, taskId), eq(runs.kind, "worker"), isNotNull(runs.endedAt))).orderBy(desc(runs.id)).get();
  const r = extractJson(run?.text ?? null, WorkerReportSchema);
  if (!r.ok || (!r.value.summary && !r.value.notes_for_reviewer)) return "";
  return ["#### Worker's report", r.value.summary, r.value.notes_for_reviewer ? `\nNotes for the reviewer: ${r.value.notes_for_reviewer}` : "", ""].join("\n");
}

function finishTask(deps: LoopDeps, project: Project, phase: Phase, task: Task): StepResult {
  const released = releaseReady(deps.db, project, phase);
  return { status: "progressed", message: `task ${task.key} done${released ? `, ${released} task(s) unlocked` : ""}` };
}

function blockOnTask(deps: LoopDeps, project: Project, task: Task): StepResult {
  const reason =
    task.status === "escalated"
      ? `Reviewer needs your input on task ${task.key}: ${task.lastFeedback ?? ""}`
      : `Task ${task.key} failed ${task.attempts}× — last problem: ${task.lastFeedback ?? "unknown"}`;
  applyProjectEvent(deps.db, getProject(deps.db, project.id), { type: "block", reason: reason.slice(0, 1_500) });
  return { status: "blocked", message: `task ${task.key} ${task.status}` };
}

function fullWorkerPrompt(db: DbOrTx, project: Project, phase: Phase, task: Task): string {
  return renderPrompt("worker", {
    key: task.key,
    title: task.title,
    phase_idx: String(phase.idx),
    phase_title: phase.title,
    phase_goal: phase.goal,
    spec: task.spec,
    acceptance: bullets(task.acceptance),
    verify_commands: task.verifyCommands.join("\n"),
    verify_timing: verifyTiming(db, project.id, task.verifyCommands),
    screens_dir: SCREENS_DIR,
    notes: reviewerNotes(db, project.id),
    owner_decisions: ownerDecisions(db, project),
    ...workerDocVars(project),
    commit_rule: commitRule(project, task),
    feedback: task.lastFeedback
      ? `\n## Problems from the previous attempt — fix all of them\n\n${truncate(task.lastFeedback, 20_000)}\n`
      : "",
  });
}

/**
 * How long the slow verify commands took in this project so far (median of
 * earlier gate runs), so the worker runs them once at the end instead of in a loop.
 */
export function verifyTiming(db: DbOrTx, projectId: string, commands: string[]): string {
  if (!commands.length) return "";
  const rows = db
    .select({ command: verifications.command, ms: verifications.durationMs })
    .from(verifications)
    .innerJoin(tasks, eq(verifications.taskId, tasks.id))
    .innerJoin(phases, eq(tasks.phaseId, phases.id))
    .where(and(eq(phases.projectId, projectId), inArray(verifications.command, commands)))
    .all();
  const slow = commands
    .map((c) => {
      const ms = rows.filter((r) => r.command === c).map((r) => r.ms).sort((a, b) => a - b);
      return { c, ms: ms.length ? ms[Math.floor(ms.length / 2)]! : 0 };
    })
    .filter((x) => x.ms >= SLOW_CHECK_MS);
  if (!slow.length) return "";
  return `\nMeasured in this project: ${slow.map((x) => `\`${x.c}\` takes about ${x.ms >= 90_000 ? `${Math.round(x.ms / 60_000)} min` : `${Math.round(x.ms / 1000)} s`}`).join("; ")}. Run these once, at the end.\n`;
}

/** What the owner decided before building: answers to the plan's open questions and the chosen design direction. */
export function ownerDecisions(db: DbOrTx, project: Project): string {
  const answers = decidedAnswers(project.outcome);
  const lines = answers.length
    ? ["", "## Decisions made before building", "", ...answers.map((a) => `- ${a.question} → **${a.answer}**${a.byOwner ? " (the owner's answer)" : " (proposed, the owner accepted it)"}`), ""]
    : [];
  return [...lines, designBrief(project), sketchForPrompt(db, project, "worker")].join("\n");
}

/** Doc references for the worker prompt; existing repos keep Orys's files in .aipm/. */
export function workerDocVars(project: Project) {
  const d = docPaths(project);
  const offLimits = project.modeDetails.existing?.offLimits ?? [];
  const scope = project.modeDetails.rework?.scope ?? [];
  const frozen = project.modeDetails.rework?.behaviorFrozen;
  const extra = [
    offLimits.length ? `- Never change these areas (the owner's rule): ${offLimits.map((x) => `\`${x}\``).join(", ")}.` : "",
    scope.length ? `- Stay inside the scope: ${scope.map((x) => `\`${x}\``).join(", ")}.` : "",
    frozen ? "- Public behavior and APIs must stay exactly the same; existing tests must keep passing unchanged." : "",
    isSandbox(project) ? "- Work only inside the current directory. Do not run any `git` command: Orys commits your work for you." : "",
  ].filter(Boolean);
  return {
    arch_doc: d.arch,
    arch_label: d.archLabel,
    state_doc: d.state,
    plan_doc: d.plan,
    project_rules: extra.length ? `\n## Project rules\n\n${extra.join("\n")}\n` : "",
  };
}

/** Rule 6 of the worker prompt: commit yourself, or (test mode) leave git to Orys. */
export function commitRule(project: Project, task: Pick<Task, "key" | "title">): string {
  return isSandbox(project)
    ? "7. Do **not** commit and do not run any `git` command: Orys commits your changes when you finish."
    : `7. Commit your work: \`git add -A && git commit -m "task(${task.key}): ${task.title}"\`.`;
}

const RESUME_HINT = "While fixing, run only the tests for what you change; run the full commands once at the end. If something outside this task was already broken before your change, do not loop on it: say so in notes_for_reviewer, starting with PRE-EXISTING:.";

function resumePrompt(task: Task): string {
  const verify = task.verifyCommands.map((c) => `  ${c}`).join("\n");
  if (task.status === "interrupted" || !task.lastFeedback) {
    return `Your session was interrupted. Check the repository state (git status/log), then continue task ${task.key} where you left off. Make sure these pass before you finish:\n${verify}\n${RESUME_HINT}\nCommit your work and end with the ${JSON_OPEN} … ${JSON_CLOSE} block.`;
  }
  return `Your work on task ${task.key} did not pass yet. Fix all of the following:\n\n${truncate(task.lastFeedback, 20_000)}\n\nThen make sure these pass:\n${verify}\n${RESUME_HINT}\nCommit your work and end with the ${JSON_OPEN} … ${JSON_CLOSE} block.`;
}

// ─────────────────────────── verification ───────────────────────────

type VerifyResult = { ok: true; summary: string } | { ok: false; failed: string; index: number; outputTail: string; feedback: string };
type BaselineResult = { red: boolean; outputTail: string };

async function runVerify(deps: LoopDeps, project: Project, commands: string[], ids: { taskId: string; runId?: string }, baseline = false): Promise<VerifyResult> {
  const lines: string[] = [];
  for (const [index, command] of commands.entries()) {
    const r = await deps.runner.exec(ws(project), command, { timeoutMs: VERIFY_TIMEOUT_MS });
    deps.db.insert(verifications).values({ taskId: ids.taskId, runId: ids.runId, command, exitCode: r.exitCode, durationMs: r.durationMs, outputTail: r.outputTail, baseline }).run();
    lines.push(`- \`${command}\` → exit ${r.exitCode} (${Math.round(r.durationMs / 1000)}s)`);
    if (r.exitCode !== 0) {
      const why = r.timedOut ? `timed out after ${VERIFY_TIMEOUT_MS / 60_000} min` : `exited with ${r.exitCode}`;
      return { ok: false, failed: command, index, outputTail: r.outputTail, feedback: `Verify command \`${command}\` ${why}. Output (last lines):\n\n\`\`\`\n${r.outputTail}\n\`\`\`` };
    }
  }
  return { ok: true, summary: lines.join("\n") };
}

/**
 * Re-run the gate on `base` up to the command that failed. `red` means that
 * same command fails there too, i.e. the failure is (at least partly) older
 * than the work being checked. The branch is restored afterwards.
 */
async function baselineCheck(deps: LoopDeps, project: Project, commands: string[], failed: Extract<VerifyResult, { ok: false }>, base: string, branch: string, taskId: string): Promise<BaselineResult> {
  const r = await atRevision(deps.runner, ws(project), base, branch, () => runVerify(deps, project, commands.slice(0, failed.index + 1), { taskId }, true));
  return r.ok ? { red: false, outputTail: "" } : { red: r.index === failed.index, outputTail: r.outputTail };
}

// ─────────────────────────── phase review ───────────────────────────

async function phaseReviewStep(deps: LoopDeps, project: Project, phase: Phase): Promise<StepResult> {
  const { db, runner, config } = deps;
  const w = ws(project);
  const list = phaseTasks(db, phase.id);
  await checkoutBranch(runner, w, phase.branch, project.integrationBranch);
  await commitAll(runner, w, `chore(phase ${phase.idx}): uncommitted leftovers`);

  // Re-run the whole phase gate on the branch tip: tasks passed one by one, the sum must pass too.
  // Plus the phase's own (slow/full) checks, which run only here.
  const gate = [...new Set([...list.filter((t) => t.status === "done").flatMap((t) => t.verifyCommands), ...phase.verifyCommands])];
  const anchor = list.at(-1)!;
  const verify = await runVerify(deps, project, gate, { taskId: anchor.id });
  let gateText = verify.ok ? `#### Phase gate (run by the system on the branch tip): passed\n${verify.summary}` : "";
  if (!verify.ok) {
    const base = await baselineCheck(deps, project, gate, verify, project.integrationBranch, phase.branch, anchor.id);
    if (!base.red) {
      addFixTask(db, project, phase, `The phase gate failed on the combined work of this phase.\n\n${verify.feedback}`, gate);
      applyPhase(db, phase, { type: "review", decision: "rework" });
      return { status: "progressed", message: `phase ${phase.idx}: combined gate failed (${verify.failed}), fix task added` };
    }
    logEvent(db, project.id, "gate_red_on_base", { phaseId: phase.id, command: verify.failed, base: project.integrationBranch });
    gateText = `#### Phase gate (run by the system on the branch tip): FAILED, but it fails before this phase too\n${disputeText(verify, base, `\`${project.integrationBranch}\` (before this phase)`)}`;
  }

  const diff = await diffForReview(runner, w, project.integrationBranch, phase.branch, config.AIPM_REVIEW_DIFF_MAX_LINES);
  const review = await runReview(deps, {
    project,
    features: listFeatures(db, project.id),
    target: "phase",
    phaseId: phase.id,
    subject: [
      `**Phase ${phase.idx}: ${phase.title}** — goal: ${phase.goal}`,
      "",
      "#### Tasks",
      bullets(list.map((t) => `\`${t.key}\` ${t.title} — ${t.status}`)),
      "",
      gateText,
      "",
      screenshots(project, list.map((t) => t.key)),
      diff,
    ].join("\n"),
    guidance: [
      ...(verify.ok ? [] : DISPUTE_GUIDANCE),
      "- Does the phase as a whole reach its goal? Do the pieces fit together?",
      "- Integration problems, duplicated code, inconsistencies between tasks?",
      "- Anything that will make the next phases harder (wrong abstractions, missing tests)?",
      "- On rework, give a concrete list: it becomes one fix-up task.",
    ].join("\n"),
  });
  if (review.kind !== "decided") return { status: review.kind === "interrupted" ? "interrupted" : "failed", message: review.message };

  const d = review.decision;
  if (d.kind === "approve") {
    await mergeBranch(runner, w, phase.branch, project.integrationBranch, `merge: phase ${phase.idx} — ${phase.title}`);
    applyPhase(db, phase, { type: "review", decision: "approve" });
    return { status: "progressed", message: `phase ${phase.idx} approved and merged into ${project.integrationBranch}` };
  }
  if (d.kind === "rework") {
    const reworks = db.select().from(decisions).where(and(eq(decisions.phaseId, phase.id), eq(decisions.target, "phase"), eq(decisions.kind, "rework"))).all().length;
    if (reworks > profileOf(project).maxAttempts) {
      applyPhase(db, phase, { type: "review", decision: "escalate" });
      applyProjectEvent(db, getProject(db, project.id), { type: "block", reason: `Phase ${phase.idx} keeps failing review: ${d.feedback}`.slice(0, 1_500) });
      return { status: "blocked", message: `phase ${phase.idx} review rework limit reached` };
    }
    addFixTask(db, project, phase, d.feedback || d.rationale, gate);
    applyPhase(db, phase, { type: "review", decision: "rework" });
    return { status: "progressed", message: `phase ${phase.idx}: review asked for fixes, fix task added` };
  }
  applyPhase(db, phase, { type: "review", decision: "escalate" });
  applyProjectEvent(db, getProject(db, project.id), { type: "block", reason: `Reviewer needs your input on phase ${phase.idx}: ${d.feedback || d.rationale}`.slice(0, 1_500) });
  return { status: "blocked", message: `phase ${phase.idx} escalated` };
}

function addFixTask(db: DbOrTx, project: Project, phase: Phase, feedback: string, gate: string[]): Task {
  const list = phaseTasks(db, phase.id);
  const n = list.filter((t) => t.key.startsWith(`p${phase.idx}-fix-`)).length + 1;
  const worker = roleOf(project, "worker");
  return db
    .insert(tasks)
    .values({
      phaseId: phase.id,
      idx: Math.max(0, ...list.map((t) => t.idx)) + 1,
      key: `p${phase.idx}-fix-${n}`,
      title: `Address phase ${phase.idx} review findings${n > 1 ? ` (round ${n})` : ""}`,
      spec: `Fix the problems found when reviewing phase ${phase.idx} ("${phase.title}") as a whole:\n\n${feedback}`,
      acceptance: ["Every point in the review findings is addressed", "All verify commands pass"],
      verifyCommands: gate.length ? gate : ["true"],
      model: worker.model,
      effort: worker.effort,
      maxAttempts: profileOf(project).maxAttempts,
      status: "ready",
    })
    .returning()
    .get();
}

/** Run execution steps until something needs waiting or a human, or `maxTasks` tasks finished. */
export async function runExecution(
  deps: LoopDeps,
  projectId: string,
  opts: { maxSteps?: number; stopAfterTasksDone?: number; onStep?: (r: StepResult) => void; signal?: AbortSignal } = {},
): Promise<StepResult> {
  const maxSteps = opts.maxSteps ?? 200;
  const doneAtStart = doneCount(deps.db, projectId);
  let failures = 0;
  let last: StepResult = { status: "idle", message: "not started" };
  for (let i = 0; i < maxSteps && !opts.signal?.aborted; i++) {
    last = await advanceExecution(deps, projectId);
    opts.onStep?.(last);
    failures = last.status === "failed" ? failures + 1 : 0;
    if (failures >= 2) return last;
    if (last.status !== "progressed" && last.status !== "failed") return last;
    if (opts.stopAfterTasksDone && doneCount(deps.db, projectId) - doneAtStart >= opts.stopAfterTasksDone) return last;
    if (getProject(deps.db, projectId).status !== "executing") return last;
  }
  return last;
}


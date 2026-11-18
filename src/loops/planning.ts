/**
 * Loop 1 (architect) and loop 2 (planner), each followed by a master review
 * (SPEC §7.1–7.2). `advancePlanning` performs one step and is safe to call
 * again after any interruption: it derives where it is from the database
 * and the project repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { resolveWorker } from "../core/profiles.js";
import { tasksToRelease } from "../core/stateMachines.js";
import { decisions, events, phases, projects, tasks, type Project, type Run } from "../db/schema.js";
import { checkoutBranch, commitAll, commitPaths, revertOutside } from "../git/index.js";
import { briefVars } from "../projects/brief.js";
import { docPaths } from "../projects/docs.js";
import { applyProjectEvent, getProject, listFeatures, logEvent, phaseBranch } from "../projects/repo.js";
import { renderPrompt } from "../prompts/render.js";
import { rotateIfTooLarge } from "../sessions/slots.js";
import { and, desc, eq, ne } from "drizzle-orm";
import { shq } from "../git/index.js";
import {
  READ_ONLY_TOOLS,
  NO_GIT,
  builderRun,
  isSandbox,
  roleOf,
  attemptsUsed,
  decisionsFor,
  isInterrupt,
  lastRun,
  markRunParseError,
  profileOf,
  truncate,
  ws,
  type LoopDeps,
  type ReviewTarget,
  type StepResult,
} from "./common.js";
import { MAPPER_DISALLOWED, MapSummarySchema, mapperFocus } from "./map.js";
import { fitToProcess, PlanSchema, renderPlanMarkdown, slugify, validatePlan, type Plan } from "./plan.js";
import { chooseProcess, type ProcessChoice } from "../core/outcome.js";
import { PROFILES } from "../core/profiles.js";
import { designStep, readDesigns } from "./design.js";
import { agreedSketch, sketchForPrompt, sketchStep } from "./sketch.js";
import { runReview } from "./review.js";

const INITIAL_STATE = "# Project state\n\nKept up to date by each task: what was done, important decisions, known gaps.\n\n_Nothing implemented yet._\n";

const INITIAL_STATE_EXISTING = (map: string) =>
  `# Project state\n\nKept up to date by each Orys task: what was done, important decisions, known gaps.\nWhat existed before Orys started is described in \`${map}\`.\n\n_No Orys task finished yet._\n`;

const SCRATCH_RULES = `- Split the work into **phases** that each deliver something working and verifiable. Phases run in order.
- **The first task sets up the project skeleton and the test/build tooling** (package manifest, config, a trivial passing test), so the verify commands can run from the start. It belongs to the first phase together with real feature work; do not make a phase that only sets up tooling.
`;

const EXISTING_RULES = `- The repository **already exists**. Never re-scaffold, replace the stack, or rewrite working parts; follow the conventions described in the map.
- Plan **only the work the owner chose** (below), most important first. Do not add unrelated improvements, and do not add preparatory phases (new test setup, characterization tests, tooling) the owner did not choose, unless the gate cannot run without them.
- Use the map's verify commands as the gate. If they do not run cleanly today, phase 1 makes them pass with the smallest possible change before anything else.
- Never touch the areas the owner marked as off-limits.
- Split the work into **phases** that each deliver something working and verifiable. Phases run in order.
`;

const REWORK_RULES = (frozen: boolean) => `${EXISTING_RULES}${
  frozen
    ? "- Behavior is **frozen**: before changing any code in scope, phase 1 adds characterization tests that pin its current behavior. Every later task keeps all existing tests passing unchanged.\n"
    : ""
}- Refactors happen in small steps; each task leaves the code working and the gate green.
- Turn every success criterion into an automated check where possible (e.g. a coverage threshold in the test command) and make the last phase verify all of them.
- Stay inside the scope paths, if any are given.
`;

/** Planner prompt variables that depend on the project's mode (SPEC §17.2) and the agreed sketch. */
function plannerModeVars(db: LoopDeps["db"], project: Project): Record<string, string> {
  const d = docPaths(project);
  const goalsText = project.mode === "scratch" ? null : read(project, d.goals);
  return {
    arch_label: d.archLabel,
    arch_doc: d.arch,
    state_doc: d.state,
    arch_title: project.mode === "scratch" ? "Approved architecture" : "Map of the existing codebase",
    goals: goalsText ? `\n${goalsText.replace(/^# /m, "## ")}\n` : "",
    mode_rules: project.mode === "scratch" ? SCRATCH_RULES : project.mode === "rework" ? REWORK_RULES(!!project.modeDetails.rework?.behaviorFrozen) : EXISTING_RULES,
    sketch: sketchForPrompt(db, project, "planner"),
  };
}

export const ArchitectSummarySchema = z.object({
  stack: z.array(z.string()).default([]),
  external_services: z.array(z.object({ name: z.string(), purpose: z.string() })).default([]),
  verify_commands: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  open_questions: z
    .array(z.object({ question: z.string(), blocking: z.boolean().default(false), assumption: z.string().optional() }))
    .default([]),
});
type ArchitectSummary = z.infer<typeof ArchitectSummarySchema>;

const read = (p: Project, rel: string) => {
  const f = join(p.repoPath, rel);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};

/** Feedback block for an author prompt: the latest reviewer/human rework, if it is newer than the last approval. */
function pendingFeedback(deps: LoopDeps, project: Project, target: ReviewTarget): string | null {
  const latest = decisionsFor(deps.db, { projectId: project.id, target })[0];
  return latest && latest.kind === "rework" && latest.feedback ? latest.feedback : null;
}

const feedbackSection = (fb: string | null, what: string) =>
  fb ? `\n## Feedback on your previous version — address every point\n\n${fb}\n\nRevise the ${what} accordingly.\n` : "";

/** True when the author's latest successful output has not been reviewed yet (ids are monotonic). */
function awaitingReview(deps: LoopDeps, project: Project, target: ReviewTarget, author: Run | undefined): boolean {
  if (!author || author.errorKind !== null || !author.endedAt) return false;
  const latest = decisionsFor(deps.db, { projectId: project.id, target })[0];
  return !latest || latest.id < author.id;
}

export async function advancePlanning(deps: LoopDeps, projectId: string): Promise<StepResult> {
  rotateIfTooLarge(deps.db, projectId, deps.config.AIPM_SESSION_MAX_CONTEXT);
  const project = getProject(deps.db, projectId);
  if (project.paused) return { status: "idle", message: "project is paused" };
  await deps.runner.ensureWorkspace(ws(project));
  if (project.status === "sketching") return sketchStep(deps, project);
  if (project.status === "mapping") return mapperStep(deps, project);
  if (project.status === "architecting") return architectStep(deps, project);
  if (project.status === "planning") return plannerStep(deps, project);
  return { status: "idle", message: `nothing to plan in status ${project.status}` };
}

// ─────────────────────────── Loop 1b: mapper (existing repos) ───────────────────────────

async function mapperStep(deps: LoopDeps, project: Project): Promise<StepResult> {
  const { db, config, runner } = deps;
  const d = docPaths(project);
  const w = ws(project);
  const features = listFeatures(db, project.id);
  const profile = profileOf(project);

  const author = lastRun(db, project.id, "mapper");
  // Same code as a map that was already approved (e.g. a second attempt on the same repo): reuse it, skip mapping.
  if (!author && !decisionsFor(db, { projectId: project.id, target: "architecture" }).length) {
    const reused = await reuseMap(deps, project);
    if (reused) return reused;
  }
  if (!(awaitingReview(deps, project, "architecture", author) && read(project, d.arch) && read(project, d.archJson))) {
    if (attemptsUsed(db, project.id, "architecture", "mapper") >= profile.maxAttempts) {
      applyProjectEvent(db, project, { type: "block", reason: `The repository map was not approved within the attempt budget. Review ${d.arch} and the decisions, then answer to continue.` });
      return { status: "blocked", message: "mapping attempts exhausted" };
    }
    // Orys's integration branch starts from the owner's branch; the owner's branch is never touched.
    await checkoutBranch(runner, w, project.integrationBranch, project.baseBranch ?? "main");

    const feedback = pendingFeedback(deps, project, "architecture");
    const role = roleOf(project, "mapper");
    const base = {
      model: role.model,
      effort: role.effort,
      permissionMode: project.workerPermissionMode,
      disallowedTools: isSandbox(project) ? [...MAPPER_DISALLOWED, ...NO_GIT] : MAPPER_DISALLOWED,
      timeoutMs: config.timeouts.mapper,
    };
    const ctx = { kind: "mapper" as const, projectId: project.id };
    const prompt = renderPrompt("mapper", {
      ...briefVars(project, features),
      dir: d.dir,
      map_doc: d.arch,
      focus: mapperFocus(project),
      feedback: feedbackSection(feedback, "map"),
    });
    const resume = feedback && author?.sessionId && author.errorKind === null ? author.sessionId : undefined;

    // Whatever happens, code changes the mapper made outside .aipm/ are thrown away.
    const cleanUp = async () => {
      const reverted = await revertOutside(runner, w, d.dir);
      if (reverted.length) logEvent(db, project.id, "mapper_changes_reverted", { files: reverted.slice(0, 50), count: reverted.length });
    };

    let { run, outcome } = await builderRun(deps, project, w, ctx, { ...base, prompt, resumeSessionId: resume });
    if (isInterrupt(outcome)) {
      await cleanUp();
      return { status: "interrupted", message: `mapper interrupted (${outcome.errorKind ?? "aborted"})` };
    }
    if (outcome.errorKind) {
      await cleanUp();
      return { status: "failed", message: `mapper run failed: ${outcome.errorKind}` };
    }

    let summary = extractJson(run.resultText, MapSummarySchema);
    const docMissing = () => !read(project, d.arch);
    if ((!summary.ok || docMissing()) && run.sessionId) {
      const problem = docMissing() ? `${d.arch} was not written.` : `The JSON block is unusable: ${!summary.ok ? summary.error : ""}`;
      ({ run, outcome } = await builderRun(deps, project, w, ctx, {
        ...base,
        resumeSessionId: run.sessionId,
        prompt: `${problem}\nFix this, then end with the ${JSON_OPEN} … ${JSON_CLOSE} block.`,
      }));
      if (isInterrupt(outcome)) {
        await cleanUp();
        return { status: "interrupted", message: "mapper interrupted during correction" };
      }
      summary = extractJson(run.resultText, MapSummarySchema);
    }
    await cleanUp();
    if (!summary.ok || docMissing()) {
      markRunParseError(db, run.id, !summary.ok ? summary.error : `${d.arch} missing`);
      return { status: "failed", message: "mapper produced unusable output" };
    }

    mkdirSync(join(project.repoPath, d.dir), { recursive: true });
    writeFileSync(join(project.repoPath, d.archJson), JSON.stringify(summary.value, null, 2) + "\n");
    await commitPaths(runner, w, [d.dir], feedback ? "aipm: revise repository map" : "aipm: map the repository");
    const tree = await baseTree(deps, project);
    if (tree) logEvent(db, project.id, "repository_mapped", { tree, source: sourceKey(project), mode: project.mode });
  }

  const doc = read(project, d.arch) ?? "";
  const summaryJson = read(project, d.archJson) ?? "{}";
  const review = await runReview(deps, {
    project,
    features,
    target: "architecture",
    subject: `Repository map of an existing project, written by the mapper.\n\n${truncate(doc, 60_000)}\n\n### Mapper's structured summary\n\n\`\`\`json\n${truncate(summaryJson, 20_000)}\n\`\`\``,
    guidance: [
      "- Is the map factual and specific (real files, commands and results), not generic?",
      "- Are the verify commands non-interactive and do they match what the mapper actually ran? If none can run today, is fixing that the first proposal?",
      "- Are the proposals concrete, independently valuable, ordered sensibly, and aligned with the owner's goals (and rework kinds/criteria, if any)?",
      "- Did it respect the owner's off-limits areas?",
      "- Escalate only if the repository cannot be worked on without a human (credentials, missing services); otherwise approve or ask for a better map.",
    ].join("\n"),
  });
  const result = await afterReview(deps, project, review, null, "repository map");
  if (review.kind === "decided" && review.decision.kind === "approve") {
    // After an agreed sketch the goal is known: straight to the plan.
    const agreed = !!agreedSketch(db, project.id);
    applyProjectEvent(db, getProject(db, project.id), { type: "map_approved", gate: agreed ? null : project.mode === "rework" ? "confirm_goal" : "pick_proposals" });
    return { status: "progressed", message: agreed ? "repository map approved — planning the agreed sketch" : "repository map approved — waiting for the owner to choose what to do" };
  }
  return result;
}

/** Which repository a project works on: the original for test-mode copies, else the repo itself. */
const sourceKey = (p: Project) => p.sourcePath ?? p.repoPath;

/** Content id of the code the mapper sees: the tree of the base branch (test-mode copies get new commit ids, same tree). */
async function baseTree(deps: LoopDeps, project: Project): Promise<string | null> {
  const r = await deps.runner.exec(ws(project), `git rev-parse ${shq(`${project.baseBranch ?? "main"}^{tree}`)}`, { timeoutMs: 30_000 });
  return r.exitCode === 0 ? r.outputTail.trim() : null;
}

/**
 * Reuse an approved map of the same repository at the same code (same base
 * tree, same mode) from another project, instead of mapping again. The owner
 * still picks what to do next. Returns null when there is nothing to reuse.
 */
async function reuseMap(deps: LoopDeps, project: Project): Promise<StepResult | null> {
  const { db, runner } = deps;
  const tree = await baseTree(deps, project);
  if (!tree) return null;
  const d = docPaths(project);
  const mapped = db.select().from(events).where(and(eq(events.type, "repository_mapped"), ne(events.projectId, project.id))).orderBy(desc(events.id)).all();
  for (const e of mapped) {
    if (e.payload.tree !== tree || e.payload.source !== sourceKey(project) || e.payload.mode !== project.mode || !e.projectId) continue;
    const old = db.select().from(projects).where(eq(projects.id, e.projectId)).get();
    if (!old) continue;
    const approved = db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.projectId, old.id), eq(decisions.target, "architecture"), eq(decisions.kind, "approve"))).get();
    if (!approved) continue;
    const show = async (path: string) => {
      const r = await runner.exec(ws(old), `git show ${shq(`${old.integrationBranch}:${path}`)}`, { timeoutMs: 30_000, tailLines: 100_000 });
      return r.exitCode === 0 ? r.outputTail : null;
    };
    const [doc, json] = [await show(d.arch), await show(d.archJson)];
    if (!doc || !json || !MapSummarySchema.safeParse(JSON.parse(json)).success) continue;

    await checkoutBranch(runner, ws(project), project.integrationBranch, project.baseBranch ?? "main");
    mkdirSync(join(project.repoPath, d.dir), { recursive: true });
    writeFileSync(join(project.repoPath, d.arch), doc.endsWith("\n") ? doc : `${doc}\n`);
    writeFileSync(join(project.repoPath, d.archJson), json.endsWith("\n") ? json : `${json}\n`);
    await commitPaths(runner, ws(project), [d.dir], `aipm: reuse the repository map from ${old.slug} (same code)`);
    db.insert(decisions).values({ projectId: project.id, target: "architecture", kind: "approve", rationale: `Reused the approved map from ${old.slug}: the code has not changed since (same tree ${tree.slice(0, 10)}).` }).run();
    logEvent(db, project.id, "map_reused", { from: old.slug, tree });
    logEvent(db, project.id, "repository_mapped", { tree, source: sourceKey(project), mode: project.mode, reusedFrom: old.slug });
    applyProjectEvent(db, getProject(db, project.id), { type: "map_approved", gate: agreedSketch(db, project.id) ? null : project.mode === "rework" ? "confirm_goal" : "pick_proposals" });
    return { status: "progressed", message: `repository map reused from ${old.slug} (same code) — waiting for the owner to choose what to do` };
  }
  return null;
}

// ─────────────────────────── Loop 1: architect ───────────────────────────

async function architectStep(deps: LoopDeps, project: Project): Promise<StepResult> {
  const { db, config } = deps;
  const d = docPaths(project);
  const features = listFeatures(db, project.id);
  const profile = profileOf(project);

  let author = lastRun(db, project.id, "architect");
  if (!(awaitingReview(deps, project, "architecture", author) && read(project, d.arch))) {
    if (attemptsUsed(db, project.id, "architecture", "architect") >= profile.maxAttempts) {
      applyProjectEvent(db, project, { type: "block", reason: `Architecture was not approved within the attempt budget. Review ${d.arch} and the decisions, then answer to continue.` });
      return { status: "blocked", message: "architecture attempts exhausted" };
    }

    const feedback = pendingFeedback(deps, project, "architecture");
    const role = roleOf(project, "architect");
    const base = { model: role.model, effort: role.effort, permissionMode: project.workerPermissionMode, timeoutMs: config.timeouts.architect };
    const ctx = { kind: "architect" as const, projectId: project.id };
    const prompt = renderPrompt("architect", { ...briefVars(project, features), sketch: sketchForPrompt(db, project, "planner"), feedback: feedbackSection(feedback, "document") });
    // Resume the previous session on rework: it keeps the context (and cache).
    const resume = feedback && author?.sessionId && author.errorKind === null ? author.sessionId : undefined;

    let { run, outcome } = await builderRun(deps, project, ws(project), ctx, { ...base, prompt, resumeSessionId: resume });
    if (isInterrupt(outcome)) return { status: "interrupted", message: `architect interrupted (${outcome.errorKind ?? "aborted"})` };
    if (outcome.errorKind) return { status: "failed", message: `architect run failed: ${outcome.errorKind}` };

    let summary = extractJson(run.resultText, ArchitectSummarySchema);
    const docMissing = () => !read(project, d.arch);
    if ((!summary.ok || docMissing()) && run.sessionId) {
      const problem = docMissing() ? `${d.arch} was not written.` : `The JSON block is unusable: ${!summary.ok ? summary.error : ""}`;
      ({ run, outcome } = await builderRun(deps, project, ws(project), ctx, {
        ...base,
        resumeSessionId: run.sessionId,
        prompt: `${problem}\nFix this, then end with the ${JSON_OPEN} … ${JSON_CLOSE} block.`,
      }));
      if (isInterrupt(outcome)) return { status: "interrupted", message: "architect interrupted during correction" };
      summary = extractJson(run.resultText, ArchitectSummarySchema);
    }
    if (!summary.ok || docMissing()) {
      markRunParseError(db, run.id, !summary.ok ? summary.error : `${d.arch} missing`);
      return { status: "failed", message: "architect produced unusable output" };
    }

    writeFileSync(join(project.repoPath, d.archJson), JSON.stringify(summary.value, null, 2) + "\n");
    await checkoutBranch(deps.runner, ws(project), project.integrationBranch, project.baseBranch ?? "main");
    await commitAll(deps.runner, ws(project), feedback ? "docs: revise architecture" : "docs: architecture");
    author = lastRun(db, project.id, "architect");
  }

  const doc = read(project, d.arch) ?? "";
  const summaryJson = read(project, d.archJson) ?? "{}";
  const review = await runReview(deps, {
    project,
    features,
    target: "architecture",
    subject: `${truncate(doc, 60_000)}\n\n### Architect's structured summary\n\n\`\`\`json\n${summaryJson}\n\`\`\``,
    guidance: [
      "- Does the stack fit the problem, constraints and optimization profile? Is anything over-engineered?",
      "- Are the verify commands concrete, non-interactive and runnable on a fresh clone?",
      "- Are security and data-handling concerns from the brief addressed?",
      "- Open questions marked BLOCKING: if they genuinely need a human (business choices, credentials), escalate with those questions. If a sensible assumption exists, approve and say which assumption to keep.",
    ].join("\n"),
  });
  return afterReview(deps, project, review, "architecture_approved", "architecture");
}

// ─────────────────────────── Loop 2: planner ───────────────────────────

async function plannerStep(deps: LoopDeps, project: Project): Promise<StepResult> {
  const { db, config } = deps;
  const d = docPaths(project);
  const features = listFeatures(db, project.id);
  const profile = profileOf(project);
  const architecture = read(project, d.arch);
  if (!architecture) {
    applyProjectEvent(db, project, { type: "block", reason: `${d.arch} is missing; cannot plan.` });
    return { status: "blocked", message: "architecture document missing" };
  }

  const author = lastRun(db, project.id, "planner");
  // Plan approved by the master reviewer (or no review needed), but not handed to the owner yet: e.g. design directions still to make.
  const latest = decisionsFor(db, { projectId: project.id, target: "plan" })[0];
  if (author && latest?.kind === "approve" && latest.id > author.id && read(project, d.planJson)) {
    return afterPlanApproved(deps, getProject(db, project.id), PlanSchema.parse(JSON.parse(read(project, d.planJson)!)));
  }
  if (!(awaitingReview(deps, project, "plan", author) && read(project, d.planJson))) {
    if (attemptsUsed(db, project.id, "plan", "planner") >= profile.maxAttempts) {
      applyProjectEvent(db, project, { type: "block", reason: `Plan was not approved within the attempt budget. Review ${d.plan} and the decisions, then answer to continue.` });
      return { status: "blocked", message: "plan attempts exhausted" };
    }

    const feedback = pendingFeedback(deps, project, "plan");
    const role = roleOf(project, "planner");
    // The planner only answers; master code writes the plan files.
    const base = { model: role.model, effort: role.effort, disallowedTools: READ_ONLY_TOOLS, timeoutMs: config.timeouts.planner };
    const ctx = { kind: "planner" as const, projectId: project.id };
    const prompt = renderPrompt("planner", {
      ...briefVars(project, features),
      ...plannerModeVars(db, project),
      architecture: truncate(architecture, 60_000),
      feedback: feedbackSection(feedback, "plan"),
      summary_language: config.AIPM_SUMMARY_LANGUAGE,
    });
    const resume = feedback && author?.sessionId && author.errorKind === null ? author.sessionId : undefined;

    let { run, outcome } = await builderRun(deps, project, ws(project), ctx, { ...base, prompt, resumeSessionId: resume });
    if (isInterrupt(outcome)) return { status: "interrupted", message: `planner interrupted (${outcome.errorKind ?? "aborted"})` };
    if (outcome.errorKind) return { status: "failed", message: `planner run failed: ${outcome.errorKind}` };

    let plan = parsePlan(run.resultText, project);
    if (!plan.ok && run.sessionId) {
      ({ run, outcome } = await builderRun(deps, project, ws(project), ctx, {
        ...base,
        resumeSessionId: run.sessionId,
        prompt: `The plan cannot be used yet:\n${plan.error}\n\nFix these problems and answer again with the complete plan in one ${JSON_OPEN} … ${JSON_CLOSE} block.`,
      }));
      if (isInterrupt(outcome)) return { status: "interrupted", message: "planner interrupted during correction" };
      plan = parsePlan(run.resultText, project);
    }
    if (!plan.ok) {
      markRunParseError(db, run.id, plan.error);
      return { status: "failed", message: "planner produced an unusable plan" };
    }

    // The master process sizes the rest of the work from the planner's scope assessment.
    db.update(projects).set({ process: plan.process }).where(eq(projects.id, project.id)).run();
    logEvent(db, project.id, "process_chosen", { mode: plan.process.mode, size: plan.process.scope.size, risk: plan.process.scope.risk, phases: plan.value.phases.length, designDirections: plan.process.designDirections });

    await checkoutBranch(deps.runner, ws(project), project.integrationBranch, project.baseBranch ?? "main");
    mkdirSync(join(project.repoPath, d.dir), { recursive: true });
    writeFileSync(join(project.repoPath, d.planJson), JSON.stringify(plan.value, null, 2) + "\n");
    writeFileSync(join(project.repoPath, d.plan), renderPlanMarkdown(plan.value, project.name));
    if (!existsSync(join(project.repoPath, d.state))) {
      writeFileSync(join(project.repoPath, d.state), project.mode === "scratch" ? INITIAL_STATE : INITIAL_STATE_EXISTING(d.arch));
    }
    await commitAll(deps.runner, ws(project), feedback ? "docs: revise implementation plan" : "docs: implementation plan");
  }

  const plan = PlanSchema.parse(JSON.parse(read(project, d.planJson)!));
  const current = getProject(db, project.id);
  const process = current.process ?? chooseProcess(plan.scope, PROFILES[current.profile]);
  const taskCount = plan.phases.reduce((n, p) => n + p.tasks.length, 0);
  if (!process.planReview) {
    // Quick job: the owner's approval (with the outcome card) is the only check the plan needs.
    db.insert(decisions).values({ projectId: project.id, target: "plan", kind: "approve", rationale: `Small job (${process.scope.size}, ${process.scope.risk} risk): no master review of the plan; the owner approves it.` }).run();
    return afterPlanApproved(deps, current, plan);
  }
  const review = await runReview(deps, {
    project,
    features,
    target: "plan",
    subject: `${plan.phases.length} phases, ${taskCount} tasks. Process chosen from the planner's scope: **${process.mode}** — ${process.why}\n\n${truncate(read(project, d.plan) ?? "", 80_000)}`,
    guidance: [
      "- Is the scope assessment honest (size, risk, UI)? It decides how much review the work gets. If it is clearly wrong, ask for rework and say why.",
      "- Does the outcome promise only what the plan builds, and say plainly what stays the same and what is needed to see it?",
      "- Can every task's verify commands run from the start (tooling set up first)? Are per-task checks fast, with the full suite only in phase verify_commands?",
      "- Does it plan only what was asked, in as few phases as needed (small work = one phase)?",
      "- Is each task small enough for one session, with a precise spec and checkable acceptance criteria?",
      "- Do verify commands actually prove the acceptance criteria (tests included in the task)?",
      "- Are dependencies and ordering right, and are high-priority features delivered early?",
      "- Is the model/effort choice per task sensible for the optimization profile?",
      "- If the plan reveals the architecture itself is unworkable, escalate and say so.",
    ].join("\n"),
  });

  const result = await afterReview(deps, project, review, null, "plan");
  if (review.kind === "decided" && review.decision.kind === "approve") return afterPlanApproved(deps, getProject(db, project.id), plan);
  return result;
}

/** After the plan is approved by the master: design directions if the work needs them, then the owner's approval. */
async function afterPlanApproved(deps: LoopDeps, project: Project, plan: Plan): Promise<StepResult> {
  // An agreed sketch already settled the look: no separate design directions.
  if (project.process?.designDirections && !readDesigns(project) && !agreedSketch(deps.db, project.id)) {
    const r = await designStep(deps, project, plan);
    if (r) return r;
  }
  persistPlan(deps, project, plan);
  const tasks = plan.phases.reduce((n, p) => n + p.tasks.length, 0);
  return { status: "progressed", message: `plan ready (${project.process?.mode ?? "standard"}): ${plan.phases.length} phases, ${tasks} tasks — waiting for the owner to approve` };
}

/** Parse and check the plan, then fit it to the process its scope calls for. */
function parsePlan(text: string | null, project: Project): { ok: true; value: Plan; process: ProcessChoice } | { ok: false; error: string } {
  const r = extractJson(text, PlanSchema);
  if (!r.ok) return r;
  const process = chooseProcess(r.value.scope, PROFILES[project.profile]);
  const fitted = fitToProcess(r.value, process);
  const problems = [...validatePlan(fitted.plan), ...fitted.problems];
  if (problems.length) return { ok: false, error: problems.map((p) => `- ${p}`).join("\n") };
  const overview = text?.slice(0, text.indexOf(JSON_OPEN)).trim();
  return { ok: true, value: { ...fitted.plan, overview: overview ? overview.slice(0, 4_000) : undefined }, process };
}

// ─────────────────────────── shared ───────────────────────────

async function afterReview(
  deps: LoopDeps,
  project: Project,
  review: Awaited<ReturnType<typeof runReview>>,
  onApprove: "architecture_approved" | null,
  what: string,
): Promise<StepResult> {
  if (review.kind === "interrupted") return { status: "interrupted", message: review.message };
  if (review.kind === "failed") return { status: "failed", message: review.message };
  const d = review.decision;
  if (d.kind === "approve") {
    if (onApprove) applyProjectEvent(deps.db, project, { type: onApprove });
    return { status: "progressed", message: `${what} approved` };
  }
  if (d.kind === "escalate") {
    applyProjectEvent(deps.db, project, { type: "block", reason: `Reviewer needs your input on the ${what}: ${d.feedback || d.rationale}` });
    return { status: "blocked", message: `${what} escalated to the owner` };
  }
  return { status: "progressed", message: `${what} needs rework: ${d.rationale}` };
}

/** Write the approved plan into the database and start execution (SPEC §7.2). */
function persistPlan(deps: LoopDeps, project: Project, plan: Plan): void {
  const profile = profileOf(project);
  const features = listFeatures(deps.db, project.id);
  const featureId = (title?: string | null) => (title ? features.find((f) => f.title.toLowerCase() === title.toLowerCase())?.id : undefined);

  deps.db.transaction((tx) => {
    const idByKey = new Map<string, string>();
    const created: { id: string; key: string; deps: string[]; phaseIdx: number }[] = [];

    plan.phases.forEach((p, pi) => {
      const idx = pi + 1;
      const phase = tx
        .insert(phases)
        .values({ projectId: project.id, idx, title: p.title, goal: p.goal, goalPlain: p.goal_plain, visible: p.visible, verifyCommands: p.verify_commands ?? [], branch: phaseBranch(project, idx, slugify(p.title)), status: idx === 1 ? "active" : "pending" })
        .returning()
        .get();
      p.tasks.forEach((t, ti) => {
        const worker = resolveWorker(profile, { model: t.model, effort: t.effort });
        const row = tx
          .insert(tasks)
          .values({
            phaseId: phase.id,
            featureId: featureId(t.feature),
            idx: ti + 1,
            key: t.key,
            title: t.title,
            spec: t.spec,
            acceptance: t.acceptance,
            verifyCommands: t.verify_commands,
            model: worker.model,
            effort: worker.effort,
            maxAttempts: profile.maxAttempts,
            size: t.size,
          })
          .returning()
          .get();
        idByKey.set(t.key, row.id);
        created.push({ id: row.id, key: t.key, deps: t.depends_on, phaseIdx: idx });
      });
    });

    for (const c of created) {
      tx.update(tasks).set({ dependsOn: c.deps.map((k) => idByKey.get(k)!) }).where(eq(tasks.id, c.id)).run();
    }
    // Release phase-1 tasks whose dependencies are already satisfied (none yet → roots).
    const phase1 = created.filter((c) => c.phaseIdx === 1).map((c) => ({ id: c.id, status: "pending" as const, dependsOn: c.deps.map((k) => idByKey.get(k)!) }));
    for (const t of tasksToRelease(phase1)) tx.update(tasks).set({ status: "ready" }).where(eq(tasks.id, t.id)).run();

    // What the owner is promised; earlier answers to the same questions are kept.
    const answers = Object.fromEntries(Object.entries(project.outcome?.answers ?? {}).filter(([q]) => plan.outcome.open_questions.some((o) => o.question === q)));
    tx.update(projects).set({ outcome: { ...plan.outcome, overview: plan.overview, answers } }).where(eq(projects.id, project.id)).run();
    // The owner reviews (and may edit) the plan before anything runs (SPEC §17.3).
    applyProjectEvent(tx, project, { type: "await_owner", gate: "approve_plan" });
    logEvent(tx, project.id, "plan_persisted", { phases: plan.phases.length, tasks: created.length });
  });
}

/** Run planning steps until the project leaves planning, blocks, or a step cannot progress. */
export async function runPlanningToCompletion(
  deps: LoopDeps,
  projectId: string,
  onStep?: (r: StepResult) => void,
  maxSteps = 20,
): Promise<StepResult> {
  let last: StepResult = { status: "idle", message: "not started" };
  let consecutiveFailures = 0;
  for (let i = 0; i < maxSteps; i++) {
    last = await advancePlanning(deps, projectId);
    onStep?.(last);
    consecutiveFailures = last.status === "failed" ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= 2) return last;
    if (last.status !== "progressed" && last.status !== "failed") return last;
    const p = getProject(deps.db, projectId);
    if (p.status !== "sketching" && p.status !== "mapping" && p.status !== "architecting" && p.status !== "planning") return last;
  }
  return last;
}

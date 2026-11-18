/**
 * Design directions (SPEC §22.2 #2): when the plan changes what people look at
 * and the look is still open, an agent builds 2–3 static mockups that differ
 * in layout and concept, not only in colour. The owner picks one when
 * approving the plan; workers follow it.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { DesignSetSchema, type DesignChoice, type DesignSet } from "../core/outcome.js";
import { decisions, runs, type Project } from "../db/schema.js";
import { checkoutBranch, commitPaths, revertOutside } from "../git/index.js";
import { briefVars } from "../projects/brief.js";
import { docPaths } from "../projects/docs.js";
import { listFeatures, logEvent } from "../projects/repo.js";
import { bullets, renderPrompt } from "../prompts/render.js";
import { NO_GIT, builderRun, isInterrupt, markRunParseError, roleOf, ws, type LoopDeps, type StepResult } from "./common.js";
import type { Plan } from "./plan.js";

export const designsDir = (p: Pick<Project, "mode">) => `${docPaths(p).dir}/designs`;

/** The directions made for this project, if any. */
export function readDesigns(project: Project): DesignSet | null {
  const f = join(project.repoPath, designsDir(project), "designs.json");
  if (!existsSync(f)) return null;
  const r = DesignSetSchema.safeParse(JSON.parse(readFileSync(f, "utf8")));
  return r.success ? r.data : null;
}

/** Text for worker and reviewer prompts: the direction the owner chose. */
export function designBrief(project: Project): string {
  const c: DesignChoice | null = project.designChoice ?? null;
  if (!c) return "";
  return [
    "",
    "## Design direction chosen by the owner",
    "",
    `Follow \`${designsDir(project)}/${c.file}\` ("${c.title}") for layout, structure and look of anything people see. It is a static mockup: match its layout and hierarchy with the project's real components and data; do not copy it file for file.`,
    c.note ? `The owner's note on it: ${c.note}` : "",
    "",
  ].filter((l, i, a) => l || a[i - 1] !== "").join("\n");
}

/**
 * Make the directions. Returns a step result while work is pending or failed,
 * null when the plan can go to the owner (directions ready, or given up
 * after two failed tries: the owner then approves without them).
 */
export async function designStep(deps: LoopDeps, project: Project, plan: Plan): Promise<StepResult | null> {
  const { db, runner, config } = deps;
  const dir = designsDir(project);
  const since = db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.projectId, project.id), eq(decisions.target, "plan"))).all().map((d) => d.id).sort().at(-1) ?? "";
  const failures = db.select({ id: runs.id }).from(runs).where(and(eq(runs.projectId, project.id), eq(runs.kind, "designer"), inArray(runs.errorKind, ["crash", "timeout", "parse"]), gt(runs.id, since))).all().length;
  if (failures >= 2) {
    logEvent(db, project.id, "design_directions_skipped", { failures });
    return null;
  }

  await checkoutBranch(runner, ws(project), project.integrationBranch, project.baseBranch ?? "main");
  mkdirSync(join(project.repoPath, dir), { recursive: true });
  const role = roleOf(project, "architect");
  const base = { model: role.model, effort: role.effort, permissionMode: project.workerPermissionMode, disallowedTools: NO_GIT, timeoutMs: config.timeouts.designer };
  const ctx = { kind: "designer" as const, projectId: project.id };
  const prompt = renderPrompt("designer", {
    ...briefVars(project, listFeatures(db, project.id)),
    summary: plan.outcome.summary_plain,
    you_will_see: bullets(plan.outcome.you_will_see.map((s) => `${s.where}: ${s.what}`)),
    scope_reason: plan.scope.reason,
    designs_dir: dir,
    summary_language: config.AIPM_SUMMARY_LANGUAGE,
  });

  const cleanUp = async () => {
    const reverted = await revertOutside(runner, ws(project), dir);
    if (reverted.length) logEvent(db, project.id, "designer_changes_reverted", { files: reverted.slice(0, 50), count: reverted.length });
  };
  let { run, outcome } = await builderRun(deps, project, ws(project), ctx, { ...base, prompt });
  if (isInterrupt(outcome)) {
    await cleanUp();
    return { status: "interrupted", message: `designer interrupted (${outcome.errorKind ?? "aborted"})` };
  }
  if (outcome.errorKind) {
    await cleanUp();
    return { status: "failed", message: `designer run failed: ${outcome.errorKind}` };
  }
  const check = () => {
    const r = extractJson(run.resultText, DesignSetSchema);
    if (!r.ok) return r;
    const missing = r.value.directions.filter((d) => !existsSync(join(project.repoPath, dir, d.file)));
    return missing.length ? { ok: false as const, error: `missing files: ${missing.map((m) => `${dir}/${m.file}`).join(", ")}` } : r;
  };
  let set = check();
  if (!set.ok && run.sessionId) {
    ({ run, outcome } = await builderRun(deps, project, ws(project), ctx, { ...base, resumeSessionId: run.sessionId, prompt: `The directions cannot be used yet: ${set.error}\nFix this, then end with the ${JSON_OPEN} … ${JSON_CLOSE} block.` }));
    if (isInterrupt(outcome)) {
      await cleanUp();
      return { status: "interrupted", message: "designer interrupted during correction" };
    }
    set = check();
  }
  await cleanUp();
  if (!set.ok) {
    markRunParseError(db, run.id, set.error);
    return { status: "failed", message: "designer produced unusable directions" };
  }
  writeFileSync(join(project.repoPath, dir, "designs.json"), JSON.stringify(set.value, null, 2) + "\n");
  await commitPaths(runner, ws(project), [dir], "docs: design directions for the owner to choose from");
  logEvent(db, project.id, "design_directions_ready", { directions: set.value.directions.map((d) => d.id) });
  return null;
}

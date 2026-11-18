import { z } from "zod";
import { extractJson, JSON_CLOSE, JSON_OPEN } from "../claude/extractJson.js";
import { DECISIONS, type Decision } from "../core/types.js";
import type { DbOrTx } from "../db/index.js";
import { decisions, type DecisionRow, type Feature, type Project } from "../db/schema.js";
import { briefVars } from "../projects/brief.js";
import { logEvent } from "../projects/repo.js";
import { renderPrompt } from "../prompts/render.js";
import { recordClaudeRun } from "../runs/recorder.js";
import { READ_ONLY_TOOLS, decisionsFor, isInterrupt, profileOf, roleOf, ws, type LoopDeps, type ReviewTarget } from "./common.js";

export const ReviewSchema = z.object({
  decision: z.enum(DECISIONS),
  rationale: z.string().min(1),
  feedback: z.string().default(""),
});

export type ReviewResult =
  | { kind: "decided"; decision: DecisionRow }
  | { kind: "interrupted"; message: string }
  | { kind: "failed"; message: string };

const TARGET_LABEL: Record<ReviewTarget, string> = {
  architecture: "architecture document",
  plan: "implementation plan",
  task: "a completed task",
  phase: "a completed phase",
};

export type ReviewRequest = {
  project: Project;
  features: Feature[];
  target: ReviewTarget;
  subject: string;
  guidance: string;
  phaseId?: string;
  taskId?: string;
};

function historyText(list: DecisionRow[]): string {
  if (!list.length) return "_(none — this is the first review)_";
  return [...list]
    .reverse()
    .map((d, i) => `${i + 1}. ${d.runId ? "reviewer" : "**human**"}: **${d.kind}** — ${d.rationale}${d.feedback ? `\n   Feedback: ${d.feedback.replace(/\n/g, "\n   ")}` : ""}`)
    .join("\n");
}

/** Run the master reviewer (read-only) and store its decision. */
export async function runReview(deps: LoopDeps, req: ReviewRequest): Promise<ReviewResult> {
  const { db, config } = deps;
  const { project } = req;
  const role = roleOf(project, "reviewer");
  const scope = { projectId: project.id, target: req.target, phaseId: req.phaseId, taskId: req.taskId };

  const prompt = renderPrompt("master-review", {
    ...briefVars(project, req.features),
    target: TARGET_LABEL[req.target],
    subject: req.subject,
    guidance: req.guidance,
    history: historyText(decisionsFor(db, scope)),
  });

  const base = {
    model: role.model,
    effort: role.effort,
    disallowedTools: READ_ONLY_TOOLS,
    timeoutMs: config.timeouts.master_review,
  };
  const ctx = { kind: "master_review" as const, projectId: project.id, phaseId: req.phaseId, taskId: req.taskId };

  let { run, outcome } = await recordClaudeRun(deps, ws(project), ctx, { ...base, prompt });
  if (isInterrupt(outcome)) return { kind: "interrupted", message: `review interrupted (${outcome.errorKind ?? "aborted"})` };
  if (outcome.errorKind) return { kind: "failed", message: `review run failed: ${outcome.errorKind}` };

  let parsed = extractJson(run.resultText, ReviewSchema);
  if (!parsed.ok && run.sessionId) {
    // One correction round in the same session (cheap: cached context).
    ({ run, outcome } = await recordClaudeRun(deps, ws(project), ctx, {
      ...base,
      resumeSessionId: run.sessionId,
      prompt: `Your answer could not be used: ${parsed.error}\nReply again with only the ${JSON_OPEN} … ${JSON_CLOSE} block.`,
    }));
    if (isInterrupt(outcome)) return { kind: "interrupted", message: "review interrupted during JSON correction" };
    parsed = extractJson(run.resultText, ReviewSchema);
  }
  if (!parsed.ok) return { kind: "failed", message: `review output unusable: ${parsed.error}` };

  const decision = db
    .insert(decisions)
    .values({
      projectId: project.id,
      phaseId: req.phaseId,
      taskId: req.taskId,
      runId: run.id,
      target: req.target,
      kind: parsed.value.decision,
      rationale: parsed.value.rationale,
      feedback: parsed.value.feedback,
    })
    .returning()
    .get();
  logEvent(db, project.id, "review_decision", { target: req.target, decision: decision.kind, taskId: req.taskId ?? null, phaseId: req.phaseId ?? null });
  return { kind: "decided", decision };
}

/** Record a human answer (unblock) as a decision; it becomes feedback for the next author run. */
export function recordUserAnswer(db: DbOrTx, project: Project, target: ReviewTarget, message: string, kind: Decision = "rework", ids: { phaseId?: string; taskId?: string } = {}): DecisionRow {
  return db
    .insert(decisions)
    .values({ projectId: project.id, target, kind, rationale: "Answer from the project owner", feedback: message, ...ids })
    .returning()
    .get();
}

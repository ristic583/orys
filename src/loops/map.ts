/** The mapper's structured output and mode-specific prompt text (SPEC §17.2). */
import { z } from "zod";
import type { Project } from "../db/schema.js";
import { REWORK_LABEL } from "../projects/brief.js";
import { docPaths } from "../projects/docs.js";

export const PROPOSAL_CATEGORIES = ["feature", "fix", "tests", "refactor", "ui", "performance", "security", "dependencies", "infra", "docs"] as const;

export const ProposalSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  why: z.string().default(""),
  category: z.enum(PROPOSAL_CATEGORIES).catch("feature"),
  effort: z.enum(["S", "M", "L"]).catch("M"),
  risk: z.enum(["low", "medium", "high"]).catch("medium"),
  recommended: z.boolean().default(false),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const MapSummarySchema = z.object({
  summary: z.string().default(""),
  stack: z.array(z.string()).default([]),
  commands: z.record(z.string(), z.string().nullable()).default({}),
  verify_commands: z.array(z.string()).default([]),
  baseline: z.record(z.string(), z.string().nullable()).default({}),
  gaps: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  proposals: z
    .array(ProposalSchema)
    .min(1, "list at least one proposal")
    .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "proposal ids must be unique"),
  open_questions: z
    .array(z.object({ question: z.string(), blocking: z.boolean().default(false), assumption: z.string().optional() }))
    .default([]),
});
export type MapSummary = z.infer<typeof MapSummarySchema>;

/** Git operations a mapper must not run: it studies the repo, it does not change history. */
export const MAPPER_DISALLOWED = ["commit", "push", "checkout", "switch", "reset", "restore", "stash", "rebase", "merge", "clean"].map((c) => `Bash(git ${c}:*)`);

export function mapperFocus(project: Project): string {
  const r = project.modeDetails.rework;
  if (project.mode === "rework" && r) {
    return [
      `**Focus:** this is a rework pass (${r.kinds.map((k) => REWORK_LABEL[k]).join(", ")}).`,
      "Measure the baseline that the success criteria are about: run the tests with coverage if tests are a goal, note slow paths if performance is, list outdated packages if dependencies are.",
      "Proposals must serve these kinds of work and criteria, smallest safe steps first.",
      r.behaviorFrozen ? "Behavior is frozen: say where characterization tests are needed before anything can be changed safely, and make that the first proposal if coverage is thin." : "",
    ].filter(Boolean).join(" ");
  }
  return [
    "**Focus:** the owner wants to continue development.",
    "Proposals should cover finishing what is half done and the owner's stated next steps; put anything that blocks safe work first (a build that does not run, no tests at all, secrets in the repo).",
  ].join(" ");
}

/** Markdown of the owner's choice, handed to the planner (written to GOALS.md). */
export function goalsMarkdown(project: Project, map: MapSummary, picked: string[], notes: string, successCriteria?: string[]): string {
  const chosen = map.proposals.filter((p) => picked.includes(p.id));
  return [
    `# What the owner chose`,
    "",
    "Plan exactly this work, in this order of importance. Nothing else.",
    "",
    ...(chosen.length ? chosen.map((p) => `- **${p.id} — ${p.title}** (${p.category}, effort ${p.effort}, risk ${p.risk}): ${p.why}`) : ["_(no proposals picked — follow the owner's notes)_"]),
    ...(notes.trim() ? ["", "## Owner's notes", "", notes.trim()] : []),
    ...(successCriteria?.length ? ["", "## Success criteria", "", ...successCriteria.map((c) => `- ${c}`)] : []),
    "",
    `_Map: ${docPaths(project).arch}_`,
    "",
  ].join("\n");
}

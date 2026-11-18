import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PROFILES, type ProfileName } from "../core/profiles.js";
import { PROJECT_MODES, REWORK_KINDS, WORKSPACES, type ReworkKind } from "../core/types.js";
import type { Feature, Project } from "../db/schema.js";

const PROFILE_NAMES = Object.keys(PROFILES) as [ProfileName, ...ProfileName[]];
const priority = z.number().int().min(1).max(5);

const lines = z.array(z.string().trim().min(1)).default([]);

export const ExistingSchema = z.object({
  currentState: z.string().trim().min(10, "describe where the project stands (at least a sentence)"),
  nextGoals: z.string().trim().default(""),
  offLimits: lines,
  verifyCommands: lines,
});

export const ReworkSchema = z.object({
  kinds: z.array(z.enum(REWORK_KINDS)).min(1, "pick at least one kind of work"),
  successCriteria: lines,
  behaviorFrozen: z.boolean().default(true),
  scope: lines,
});

export const BriefSchema = z
  .object({
    mode: z.enum(PROJECT_MODES).default("scratch"),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "slug: lowercase letters, digits and dashes"),
    name: z.string().min(1),
    /** What the project is for (scratch: the problem to solve). */
    problem: z.string().min(10),
    aspects: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    priority: priority.default(3),
    profile: z.enum(PROFILE_NAMES).optional(),
    deadline: z.coerce.date().optional(),
    /** Existing repository (modes existing and rework). */
    repoPath: z.string().trim().min(1).optional(),
    /** in_place: ai-pm/* branches in the repo; sandbox: work on a copy, the original is never touched. */
    workspace: z.enum(WORKSPACES).default("in_place"),
    existing: ExistingSchema.optional(),
    rework: ReworkSchema.optional(),
    features: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().default(""),
          priority: priority.default(3),
          deadline: z.coerce.date().optional(),
        }),
      )
      .default([]),
  })
  .superRefine((b, ctx) => {
    if (b.mode === "scratch") {
      if (b.repoPath) ctx.addIssue({ code: "custom", path: ["repoPath"], message: "a scratch project gets a new folder; use mode \"existing\" for an existing repo" });
      if (b.workspace === "sandbox") ctx.addIssue({ code: "custom", path: ["workspace"], message: "test mode (a copy) only applies to existing repositories" });
      return;
    }
    if (!b.repoPath) ctx.addIssue({ code: "custom", path: ["repoPath"], message: "path to the existing repository is required" });
    if (b.mode === "existing" && !b.existing) ctx.addIssue({ code: "custom", path: ["existing"], message: "answers for a project in progress are required" });
    if (b.mode === "rework" && !b.rework) ctx.addIssue({ code: "custom", path: ["rework"], message: "answers for the rework are required" });
  });
export type Brief = z.infer<typeof BriefSchema>;

export function loadBriefFile(path: string): Brief {
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return BriefSchema.parse(raw);
}

const PROFILE_TEXT: Record<ProfileName, string> = {
  quality: "quality — correctness, maintainability and security matter most; spend tokens where it improves the result.",
  balanced: "balanced — solid, tested code at a reasonable token cost.",
  speed: "speed — reach a working result quickly; keep scope tight and avoid gold-plating.",
  cost: "cost — minimize token usage; prefer simple solutions and fewer, larger steps.",
};

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Values for the `_brief` prompt partial. */
export function briefVars(project: Project, features: Feature[]): Record<string, string> {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_(none given)_");
  const feats = [...features]
    .sort((a, b) => b.priority - a.priority)
    .map((f) => `- **${f.title}** (priority ${f.priority}${f.deadline ? `, due ${day(f.deadline)}` : ""})${f.description ? `: ${f.description}` : ""}`);
  return {
    name: project.name,
    problem: project.problem,
    aspects: list(project.aspects),
    constraints: list(project.constraints),
    features: feats.length ? feats.join("\n") : "_(none given)_",
    deadline: day(project.deadline) ?? "none",
    profile: PROFILE_TEXT[project.profile],
    mode_brief: modeBrief(project),
  };
}

export const REWORK_LABEL: Record<ReworkKind, string> = {
  redesign_ui: "Redesign the UI",
  refactor: "Refactor the architecture",
  tests: "Tests and coverage",
  performance: "Performance",
  security: "Security hardening",
  dependencies: "Dependency upgrades",
};

/** Extra brief section for projects in an existing repository (SPEC §17). */
export function modeBrief(project: Project): string {
  const list = (xs: string[], none = "_(none)_") => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : none);
  const e = project.modeDetails.existing;
  if (project.mode === "existing" && e) {
    return [
      "\n## This is an existing project",
      "The code already exists in this repository; work with it, do not start over.",
      `\n**Where it stands (owner):** ${e.currentState}`,
      e.nextGoals ? `\n**What should happen next (owner):** ${e.nextGoals}` : "",
      `\n**Never change these areas:**\n${list(e.offLimits)}`,
      `\n**Verify commands the owner knows:**\n${list(e.verifyCommands, "_(none given — find them)_")}`,
    ].filter(Boolean).join("\n");
  }
  const r = project.modeDetails.rework;
  if (project.mode === "rework" && r) {
    return [
      "\n## This is a rework of an existing project",
      "The code already exists in this repository and mostly works. The goal is to improve it, not to rebuild it.",
      `\n**Kinds of work:** ${r.kinds.map((k) => REWORK_LABEL[k]).join(", ")}`,
      `\n**Success criteria:**\n${list(r.successCriteria, "_(none given — propose measurable ones)_")}`,
      `\n**Keep behavior the same:** ${r.behaviorFrozen ? "yes — public APIs and user-visible behavior must not change." : "no — behavior may change where it serves the goals."}`,
      `\n**Scope:** ${r.scope.length ? r.scope.map((x) => `\`${x}\``).join(", ") : "the whole repository"}`,
    ].join("\n");
  }
  return "";
}

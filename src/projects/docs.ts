/**
 * Where Orys keeps its own documents inside a project repository. Scratch
 * projects are Orys's repos, so `docs/`; in an owner's existing repo they go
 * to `.aipm/`, so they never collide with the owner's own docs (SPEC §17).
 */
import type { Project } from "../db/schema.js";

export type DocPaths = {
  dir: string;
  /** Architecture (scratch) or the repository map (existing repos): the planner's main input. */
  arch: string;
  /** Structured JSON summary of `arch`. */
  archJson: string;
  plan: string;
  planJson: string;
  state: string;
  /** The owner's choice after mapping (existing repos only). */
  goals: string;
  /** How prompts refer to `arch`. */
  archLabel: string;
};

export function docPaths(p: Pick<Project, "mode">): DocPaths {
  if (p.mode === "scratch") {
    return {
      dir: "docs",
      arch: "docs/ARCHITECTURE.md",
      archJson: "docs/architecture.json",
      plan: "docs/PLAN.md",
      planJson: "docs/plan.json",
      state: "docs/STATE.md",
      goals: "docs/GOALS.md",
      archLabel: "the approved architecture",
    };
  }
  return {
    dir: ".aipm",
    arch: ".aipm/MAP.md",
    archJson: ".aipm/map.json",
    plan: ".aipm/PLAN.md",
    planJson: ".aipm/plan.json",
    state: ".aipm/STATE.md",
    goals: ".aipm/GOALS.md",
    archLabel: "the map of this existing codebase",
  };
}

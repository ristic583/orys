/**
 * The owner's decision after mapping (SPEC §17.2): which proposals to do, with
 * notes; for a rework also the confirmed success criteria. The choice is written
 * to GOALS.md (the planner's input) and recorded as an owner decision.
 */
import { eq } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projects, type Project } from "../db/schema.js";
import { checkoutBranch, commitPaths } from "../git/index.js";
import { ws, type LoopDeps } from "../loops/common.js";
import { goalsMarkdown, MapSummarySchema, type MapSummary } from "../loops/map.js";
import { recordUserAnswer } from "../loops/review.js";
import { docPaths } from "./docs.js";
import { applyProjectEvent, getProject, logEvent } from "./repo.js";

/** Proposal categories the owner can see; these get a sketch before the plan (sketch-first projects). */
const VISIBLE_CATEGORIES = new Set(["feature", "ui"]);

export const OwnerChoiceSchema = z.object({
  picked: z.array(z.string()).default([]),
  notes: z.string().trim().max(10_000).default(""),
  /** Rework only: the criteria as confirmed or edited by the owner. */
  successCriteria: z.array(z.string().trim().min(1)).optional(),
});
export type OwnerChoice = z.infer<typeof OwnerChoiceSchema>;

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** The mapper's structured map, or null if it has not been written yet. */
export function readMap(project: Project): MapSummary | null {
  const f = join(project.repoPath, docPaths(project).archJson);
  if (!existsSync(f)) return null;
  const r = MapSummarySchema.safeParse(JSON.parse(readFileSync(f, "utf8")));
  return r.success ? r.data : null;
}

export async function decideAfterMapping(deps: Pick<LoopDeps, "db" | "runner">, idOrSlug: string, input: OwnerChoice): Promise<Project> {
  const { db } = deps;
  let project = getProject(db, idOrSlug);
  if (project.status !== "awaiting_owner" || (project.ownerGate !== "pick_proposals" && project.ownerGate !== "confirm_goal")) {
    throw new GateError(`project ${project.slug} is not waiting for a choice after mapping`);
  }
  const map = readMap(project);
  if (!map) throw new GateError("the repository map is missing or unreadable");
  const choice = OwnerChoiceSchema.parse(input);
  const unknown = choice.picked.filter((id) => !map.proposals.some((p) => p.id === id));
  if (unknown.length) throw new GateError(`unknown proposal ids: ${unknown.join(", ")}`);
  if (!choice.picked.length && !choice.notes) throw new GateError("pick at least one proposal or describe what to do in the notes");

  // Rework: the owner may adjust the success criteria before planning.
  if (project.mode === "rework" && choice.successCriteria && project.modeDetails.rework) {
    project = db
      .update(projects)
      .set({ modeDetails: { ...project.modeDetails, rework: { ...project.modeDetails.rework, successCriteria: choice.successCriteria } } })
      .where(eq(projects.id, project.id))
      .returning()
      .get();
  }

  const d = docPaths(project);
  const goals = goalsMarkdown(project, map, choice.picked, choice.notes, project.mode === "rework" ? project.modeDetails.rework?.successCriteria : undefined);
  await checkoutBranch(deps.runner, ws(project), project.integrationBranch, project.baseBranch ?? "main");
  writeFileSync(join(project.repoPath, d.goals), goals);
  await commitPaths(deps.runner, ws(project), [d.goals], "aipm: owner's choice of work");

  return db.transaction((tx) => {
    recordUserAnswer(tx, project, "architecture", goals, "approve");
    logEvent(tx, project.id, "owner_choice", { picked: choice.picked, notes: choice.notes.slice(0, 500), gate: project.ownerGate });
    // Sketch first: when the chosen work is something to look at, show a sketch before planning it.
    const visible = choice.picked.some((id) => VISIBLE_CATEGORIES.has(map.proposals.find((p) => p.id === id)?.category ?? "")) || (!choice.picked.length && !!choice.notes);
    const next = project.sketch && project.ownerGate === "pick_proposals" && visible ? "sketching" : undefined;
    return applyProjectEvent(tx, getProject(tx, project.id), { type: "owner_decided", next });
  });
}

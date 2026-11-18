import { eq } from "drizzle-orm";
import { z } from "zod";
import { PROFILES, type ProfileName } from "../core/profiles.js";
import { AGENT_ROLES, EFFORTS, MODELS, type AgentRole, type RoleModels } from "../core/types.js";
import type { DbOrTx } from "../db/index.js";
import { projects, type Project } from "../db/schema.js";
import { getProject, logEvent } from "./repo.js";

const PROFILE_NAMES = Object.keys(PROFILES) as [ProfileName, ...ProfileName[]];

/** Settings the owner may change at any time; they only affect scheduling and future runs. */
export const ProjectPatchSchema = z
  .object({
    priority: z.number().int().min(1).max(5),
    profile: z.enum(PROFILE_NAMES),
    /** ISO date/time, or null to clear. */
    deadline: z.union([z.null(), z.coerce.date()]),
    paused: z.boolean(),
    /** Per-role model overrides; null for a role restores the profile default. */
    roleModels: z.partialRecord(z.enum(AGENT_ROLES), z.object({ model: z.enum(MODELS), effort: z.enum(EFFORTS) }).nullable()),
  })
  .partial()
  .strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

export function updateProjectSettings(db: DbOrTx, idOrSlug: string, patch: ProjectPatch): Project {
  const p = getProject(db, idOrSlug);
  const { roleModels: roleChanges, ...set } = ProjectPatchSchema.parse(patch);
  if (!Object.keys(set).length && !roleChanges) return p;
  let roleModels: RoleModels | undefined;
  if (roleChanges) {
    roleModels = { ...p.roleModels };
    for (const [role, v] of Object.entries(roleChanges) as [AgentRole, RoleModels[AgentRole] | null][]) {
      if (v) roleModels[role] = v;
      else delete roleModels[role];
    }
  }
  const row = db.update(projects).set({ ...set, ...(roleModels ? { roleModels } : {}) }).where(eq(projects.id, p.id)).returning().get();
  logEvent(db, p.id, "project_settings", { ...set, ...(roleChanges ? { roleModels: roleChanges } : {}), deadline: set.deadline === undefined ? undefined : (set.deadline?.toISOString() ?? null) });
  return row;
}

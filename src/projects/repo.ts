import { asc, eq } from "drizzle-orm";
import { expandPath, inspectRepo } from "./inspect.js";
import { copyIntoSandbox } from "./sandbox.js";
import { claimSlot } from "../sessions/slots.js";
import { join } from "node:path";
import { transitionProject, type ProjectEvent } from "../core/stateMachines.js";
import type { ProfileName } from "../core/profiles.js";
import type { Db, DbOrTx } from "../db/index.js";
import { events, features, projects, type Project } from "../db/schema.js";
import type { Brief } from "./brief.js";

export function logEvent(db: DbOrTx, projectId: string | null, type: string, payload: Record<string, unknown> = {}): void {
  db.insert(events).values({ projectId, type, payload }).run();
}

/**
 * Insert a project. For existing repos call `createProjectFromBrief`, which
 * inspects the repository first and passes its current branch as `baseBranch`.
 */
export function createProject(db: Db, brief: Brief, opts: { projectsDir: string; defaultProfile: ProfileName; baseBranch?: string; sourcePath?: string }): Project {
  const scratch = brief.mode === "scratch";
  if (!scratch && !opts.baseBranch) throw new Error("existing repositories need a base branch (use createProjectFromBrief)");
  return db.transaction((tx) => {
    const project = tx
      .insert(projects)
      .values({
        slug: brief.slug,
        name: brief.name,
        problem: brief.problem,
        aspects: brief.aspects,
        constraints: brief.constraints,
        priority: brief.priority,
        profile: brief.profile ?? opts.defaultProfile,
        deadline: brief.deadline,
        mode: brief.mode,
        modeDetails: brief.mode === "existing" ? { existing: brief.existing } : brief.mode === "rework" ? { rework: brief.rework } : {},
        repoPath: scratch ? join(opts.projectsDir, brief.slug) : expandPath(brief.repoPath!),
        baseBranch: scratch ? null : opts.baseBranch,
        integrationBranch: scratch ? "main" : AIPM_INTEGRATION_BRANCH,
        workspace: brief.workspace,
        sourcePath: brief.workspace === "sandbox" ? opts.sourcePath : null,
      })
      .returning()
      .get();
    for (const f of brief.features) {
      tx.insert(features).values({ projectId: project.id, ...f }).run();
    }
    logEvent(tx, project.id, "project_created", { slug: project.slug, mode: project.mode });
    return project;
  });
}

/** Branch in an existing repo where approved phases accumulate before the owner merges them. */
export const AIPM_INTEGRATION_BRANCH = "ai-pm/main";

/** Phase branch name: `phase/…` in Orys's own repos, `ai-pm/phase-…` in an existing repo. */
export function phaseBranch(project: Pick<Project, "mode">, idx: number, slug: string): string {
  return project.mode === "scratch" ? `phase/${idx}-${slug}` : `ai-pm/phase-${idx}-${slug}`;
}

/** draft → architecting (scratch) or mapping (existing repo). */
/**
 * draft → sketching when the owner said what they want and sketching is on
 * (SPEC §22.7); else architecting (scratch) or mapping (existing repo, e.g.
 * "map it and propose").
 */
export function startProject(db: DbOrTx, project: Project, opts: { sketch?: boolean } = {}): Project {
  const sketch = !!opts.sketch;
  if (sketch !== project.sketch) project = db.update(projects).set({ sketch }).where(eq(projects.id, project.id)).returning().get();
  const first = sketch && wantsSketchFirst(project) ? "sketching" : project.mode === "scratch" ? "architecting" : "mapping";
  return applyProjectEvent(db, project, { type: "start", firstStage: first });
}

/** The goal is known and visible enough to sketch before mapping: new projects, a stated next goal, a UI redesign. */
export function wantsSketchFirst(p: Pick<Project, "mode" | "modeDetails">): boolean {
  if (p.mode === "scratch") return true;
  if (p.mode === "existing") return !!p.modeDetails.existing?.nextGoals?.trim();
  return !!p.modeDetails.rework?.kinds.includes("redesign_ui");
}

export class RepoNotUsable extends Error {
  constructor(public readonly problems: string[]) {
    super(`repository cannot be used: ${problems.join(" ")}`);
    this.name = "RepoNotUsable";
  }
}

/** Create a project from a validated brief; existing repos are inspected first. */
export async function createProjectFromBrief(
  db: Db,
  brief: Brief,
  opts: { projectsDir: string; defaultProfile: ProfileName; aipmRoot?: string; sandboxDir?: string; claimSessionSlot?: boolean },
): Promise<Project> {
  const project = await createFromBrief(db, brief, opts);
  // One long-lived Claude session per project, when a slot is free (SPEC §17.7).
  if (opts.claimSessionSlot) claimSlot(db, project);
  return getProject(db, project.id);
}

async function createFromBrief(
  db: Db,
  brief: Brief,
  opts: { projectsDir: string; defaultProfile: ProfileName; aipmRoot?: string; sandboxDir?: string },
): Promise<Project> {
  if (db.select({ id: projects.id }).from(projects).where(eq(projects.slug, brief.slug)).get()) throw new Error(`a project with slug "${brief.slug}" already exists`);
  if (brief.mode === "scratch") return createProject(db, brief, opts);
  if (brief.workspace === "sandbox") {
    // Test mode: the original is only read; agents get a copy of their own.
    const source = await inspectRepo(brief.repoPath!, { aipmRoot: opts.aipmRoot, forCopy: true });
    if (source.problems.length) throw new RepoNotUsable(source.problems);
    const dest = join(opts.sandboxDir ?? join(opts.projectsDir, "..", "aipm-sandbox"), brief.slug);
    const copy = await copyIntoSandbox(source.path, dest);
    const project = createProject(db, { ...brief, repoPath: copy.path }, { ...opts, baseBranch: copy.baseBranch, sourcePath: source.path });
    logEvent(db, project.id, "sandbox_created", { source: source.path, copy: copy.path, baseBranch: copy.baseBranch, initialized: copy.initialized, snapshot: copy.snapshot, skipped: copy.skipped });
    return project;
  }
  const taken = new Map(db.select({ repoPath: projects.repoPath, slug: projects.slug }).from(projects).all().map((p) => [p.repoPath, p.slug]));
  const repo = await inspectRepo(brief.repoPath!, { taken, aipmRoot: opts.aipmRoot });
  if (repo.problems.length) throw new RepoNotUsable(repo.problems);
  return createProject(db, { ...brief, repoPath: repo.path }, { ...opts, baseBranch: repo.branch! });
}

export function getProject(db: DbOrTx, idOrSlug: string): Project {
  const p =
    db.select().from(projects).where(eq(projects.id, idOrSlug)).get() ??
    db.select().from(projects).where(eq(projects.slug, idOrSlug)).get();
  if (!p) throw new Error(`project not found: ${idOrSlug}`);
  return p;
}

export function listFeatures(db: DbOrTx, projectId: string) {
  return db.select().from(features).where(eq(features.projectId, projectId)).orderBy(asc(features.createdAt)).all();
}

/** Apply a state-machine event to a project and persist it, with an audit event. */
export function applyProjectEvent(db: DbOrTx, project: Project, e: ProjectEvent): Project {
  const next = transitionProject(
    { status: project.status, blockedFrom: project.blockedFrom, blockedReason: project.blockedReason, ownerGate: project.ownerGate },
    e,
  );
  const updated = db.update(projects).set(next).where(eq(projects.id, project.id)).returning().get();
  logEvent(db, project.id, "project_status", { from: project.status, to: next.status, event: e.type, ...(e.type === "block" ? { reason: e.reason } : {}) });
  return updated;
}

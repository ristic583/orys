/**
 * Deleting a project. Orys forgets it (plan, runs, events, session, sketches: the database
 * cascades) and removes its run logs. A folder Orys made itself (the copy in test mode, the
 * new repo of a project from scratch) goes only when the owner ticks it. The owner's own
 * repository is never touched; its `ai-pm/*` branches stay where they are.
 */
import { rmSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { projects, runs, sessionSlots, type Project } from "../db/schema.js";
import { getProject, logEvent } from "./repo.js";

export class DeleteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteRefused";
  }
}

export type DeletionPreview = {
  slug: string;
  name: string;
  /** A folder Orys created and may remove with the project. */
  orysFolder: { path: string; kind: "sandbox" | "scratch" } | null;
  /** The owner's repository: stays as it is. */
  ownerRepo: string | null;
  runs: number;
};

const inside = (dir: string, path: string) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The folder Orys made for this project, only if it really lies in Orys's own directories. */
export function orysFolder(p: Pick<Project, "repoPath" | "workspace" | "mode">, config: Pick<Config, "AIPM_SANDBOX_DIR" | "AIPM_PROJECTS_DIR">): DeletionPreview["orysFolder"] {
  if (p.workspace === "sandbox" && inside(config.AIPM_SANDBOX_DIR, p.repoPath)) return { path: p.repoPath, kind: "sandbox" };
  if (p.mode === "scratch" && inside(config.AIPM_PROJECTS_DIR, p.repoPath)) return { path: p.repoPath, kind: "scratch" };
  return null;
}

export function deletionPreview(db: Db, config: Config, idOrSlug: string): DeletionPreview {
  const p = getProject(db, idOrSlug);
  const folder = orysFolder(p, config);
  const ownerRepo = folder ? (p.sourcePath ?? null) : p.mode === "scratch" ? null : p.repoPath;
  return { slug: p.slug, name: p.name, orysFolder: folder, ownerRepo, runs: db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, p.id)).all().length };
}

export function deleteProject(
  db: Db,
  config: Config,
  idOrSlug: string,
  opts: { confirm: string; removeFolder?: boolean; busy?: (projectId: string) => boolean },
): { deleted: string; removedFolder: string | null; removedLogs: number } {
  const p = getProject(db, idOrSlug);
  if (opts.confirm.trim() !== p.slug) throw new DeleteRefused(`To delete, type the project's short name exactly: ${p.slug}`);
  if (opts.busy?.(p.id)) throw new DeleteRefused("An agent is working on this project right now. Pause it, wait until the step stops, then delete.");
  const folder = opts.removeFolder ? orysFolder(p, config) : null;
  const logs = db.select({ logPath: runs.logPath }).from(runs).where(eq(runs.projectId, p.id)).all().flatMap((r) => (r.logPath ? [r.logPath] : []));

  db.transaction((tx) => {
    tx.delete(sessionSlots).where(eq(sessionSlots.projectId, p.id)).run();
    tx.delete(projects).where(eq(projects.id, p.id)).run(); // phases, tasks, runs, events, sketches… cascade
    logEvent(tx, null, "project_deleted", { slug: p.slug, name: p.name, runs: logs.length, removedFolder: folder?.path ?? null });
  });

  let removedLogs = 0;
  for (const path of logs) {
    if (!inside(config.AIPM_RUNS_DIR, path)) continue;
    try {
      rmSync(path, { force: true });
      removedLogs++;
    } catch {
      // a log that cannot be removed is not worth failing the delete
    }
  }
  if (folder) rmSync(folder.path, { recursive: true, force: true });
  return { deleted: p.slug, removedFolder: folder?.path ?? null, removedLogs };
}

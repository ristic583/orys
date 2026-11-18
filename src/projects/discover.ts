/**
 * Find git repositories on this machine for the new-project wizard, so the
 * owner picks one instead of typing a path. A bounded walk: a few levels deep,
 * no hidden folders, no dependency or system folders, never inside a repo
 * (a repo's own sub-folders are its business), and a time budget.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export type FoundRepo = {
  path: string;
  name: string;
  /** Last time git touched the repo (index or HEAD), ISO; null when unknown. */
  lastActivity: string | null;
};

export type DiscoverOptions = {
  roots: string[];
  /** Folders (and everything under them) to leave out, e.g. Orys's own repo and its sandbox copies. */
  exclude?: string[];
  /** Levels below each root to look at. */
  maxDepth?: number;
  timeBudgetMs?: number;
  /** At most this many repos (most recently active first). */
  limit?: number;
};

/** Never worth walking into: dependencies, build output, caches and system folders. */
const SKIP = new Set([
  "node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage", "venv", "env", "__pycache__",
  "Library", "Applications", "Pictures", "Music", "Movies", "Public", "Photos Library.photoslibrary",
  "go", "Pods", "DerivedData",
]);

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};

async function lastActivity(repo: string): Promise<string | null> {
  const times = await Promise.all(
    ["index", "HEAD", "FETCH_HEAD"].map((f) => stat(join(repo, ".git", f)).then((s) => s.mtimeMs, () => 0)),
  );
  const t = Math.max(...times);
  return t > 0 ? new Date(t).toISOString() : null;
}

export async function discoverRepos(opts: DiscoverOptions): Promise<{ repos: FoundRepo[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 5;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 4_000);
  const exclude = (opts.exclude ?? []).map((p) => resolve(p));
  const found: string[] = [];
  let truncated = false;

  // Breadth-first so shallow (likely) repos are found first if time runs out.
  let level = opts.roots.map((r) => resolve(r));
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 32) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      await Promise.all(
        level.slice(i, i + 32).map(async (dir) => {
          if (exclude.some((e) => isInside(dir, e))) return;
          let entries: Dirent[];
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return; // no permission, vanished, not a folder
          }
          // `.git` folder, or a `.git` file (worktree / submodule).
          if (entries.some((e) => e.name === ".git" && (e.isDirectory() || e.isFile()))) {
            found.push(dir);
            return;
          }
          if (depth === maxDepth) return;
          for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name) || e.name.endsWith(".app")) continue;
            next.push(join(dir, e.name));
          }
        }),
      );
    }
    if (truncated) break;
    level = next;
  }

  const repos = await Promise.all(found.map(async (path) => ({ path, name: basename(path), lastActivity: await lastActivity(path) })));
  repos.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name));
  const limit = opts.limit ?? 500;
  return { repos: repos.slice(0, limit), truncated: truncated || repos.length > limit };
}

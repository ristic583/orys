/**
 * Test mode for existing repos: agents work on a copy, and the owner's original
 * folder is never written to — no branches, commits, init or any git command
 * that changes it. The copy is Orys's own: it has no remotes (nothing can be
 * pushed anywhere), its git hooks are off, and uncommitted work is snapshotted.
 */
import { execa } from "execa";
import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/** Heavy or generated folders that are not copied; agents reinstall/rebuild them. */
export const COPY_SKIP = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
  "dist", "build", "target", "coverage", ".pytest_cache", ".mypy_cache", ".gradle", ".DS_Store",
]);

const IDENTITY = ["-c", "user.name=Orys", "-c", "user.email=orys@localhost"];

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export type SandboxResult = { path: string; baseBranch: string; initialized: boolean; snapshot: boolean; skipped: string[] };

/** Copy `source` to `dest` and make the copy a self-contained git repo. Only `dest` is written. */
export async function copyIntoSandbox(source: string, dest: string): Promise<SandboxResult> {
  if (existsSync(dest) && readdirSync(dest).length) throw new SandboxError(`the sandbox folder ${dest} already exists and is not empty`);
  const skipped = new Set<string>();
  cpSync(source, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = basename(src);
      if (src !== source && COPY_SKIP.has(name)) {
        skipped.add(name);
        return false;
      }
      return true;
    },
  });

  const git = (...args: string[]) => execa("git", [...IDENTITY, ...args], { cwd: dest, env: { GIT_DIR: join(dest, ".git"), GIT_WORK_TREE: dest } });
  const gitPath = join(dest, ".git");
  // A `.git` *file* (worktree or submodule) points at the original's git directory: never follow it.
  if (existsSync(gitPath) && !lstatSync(gitPath).isDirectory()) rmSync(gitPath, { force: true });

  let initialized = false;
  if (!existsSync(gitPath)) {
    await execa("git", ["init", "-q", "-b", "main"], { cwd: dest });
    initialized = true;
  }
  // Nothing in the copy may reach the outside: no remotes, no hooks.
  await git("config", "core.hooksPath", "/dev/null");
  const remotes = (await git("remote")).stdout.split("\n").filter(Boolean);
  for (const r of remotes) await git("remote", "remove", r);

  let branch = (await git("symbolic-ref", "--short", "-q", "HEAD").catch(() => ({ stdout: "" }))).stdout.trim();
  const hasCommits = (await git("rev-parse", "--verify", "-q", "HEAD").catch(() => null)) !== null;
  if (!branch || branch.startsWith("ai-pm/")) {
    branch = "aipm-base";
    await git("switch", "-q", ...(hasCommits ? ["-c", branch] : ["--orphan", branch]));
  }
  await git("add", "-A");
  const staged = await git("diff", "--cached", "--quiet").then(() => false, () => true);
  let snapshot = false;
  if (staged || !hasCommits) {
    await git("commit", "-q", "--allow-empty", "-m", initialized || !hasCommits ? `aipm: snapshot of ${source}` : "aipm: snapshot of uncommitted changes");
    snapshot = true;
  }
  return { path: dest, baseBranch: branch, initialized, snapshot, skipped: [...skipped].sort() };
}

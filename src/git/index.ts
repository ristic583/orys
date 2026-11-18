import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runner, Workspace } from "../runner/types.js";

/** Quote a value for POSIX sh. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const GIT = "git -c user.name='Orys' -c user.email=orys@localhost";
const T = { timeoutMs: 60_000 };

export class GitError extends Error {}

async function git(runner: Runner, ws: Workspace, args: string, tailLines?: number): Promise<string> {
  const r = await runner.exec(ws, `${GIT} ${args}`, { ...T, tailLines });
  if (r.exitCode !== 0) throw new GitError(`git ${args} failed (${r.exitCode}): ${r.outputTail}`);
  return r.outputTail.trim();
}

export async function isDirty(runner: Runner, ws: Workspace): Promise<boolean> {
  return (await git(runner, ws, "status --porcelain")).length > 0;
}

/** Commit everything if there is anything to commit. Returns true when a commit was made. */
export async function commitAll(runner: Runner, ws: Workspace, message: string): Promise<boolean> {
  if (!(await isDirty(runner, ws))) return false;
  await git(runner, ws, "add -A");
  await git(runner, ws, `commit -q -m ${shq(message)}`);
  return true;
}

export async function currentBranch(runner: Runner, ws: Workspace): Promise<string> {
  return git(runner, ws, "rev-parse --abbrev-ref HEAD");
}

/**
 * Undo what a read-only agent changed outside `keep/`: tracked files go back
 * to HEAD, new untracked (not ignored) files are removed. The tree was clean
 * before the agent ran, so anything else is the agent's. Returns changed paths.
 */
export async function revertOutside(runner: Runner, ws: Workspace, keep: string): Promise<string[]> {
  const r = await runner.exec(ws, `${GIT} status --porcelain -z`, { ...T, tailLines: 100_000 });
  if (r.exitCode !== 0) throw new GitError(`git status failed: ${r.outputTail}`);
  const entries = r.outputTail.split("\0");
  const changed: { path: string; untracked: boolean }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    changed.push({ path: e.slice(3), untracked: xy === "??" });
    if (xy[0] === "R" || xy[0] === "C") i++; // the next entry is the original path
  }
  const outside = changed.filter((c) => c.path !== keep && !c.path.startsWith(`${keep}/`));
  if (!outside.length) return [];
  const tracked = outside.filter((c) => !c.untracked).map((c) => c.path);
  if (tracked.length) await git(runner, ws, `restore --source=HEAD --staged --worktree -- ${tracked.map(shq).join(" ")}`);
  if (outside.some((c) => c.untracked)) await git(runner, ws, `clean -fdq -e ${shq(keep)} -- .`);
  return outside.map((c) => c.path);
}

/** Commit only `paths`. Returns false when there was nothing to commit. */
export async function commitPaths(runner: Runner, ws: Workspace, paths: string[], message: string): Promise<boolean> {
  await git(runner, ws, `add -A -- ${paths.map(shq).join(" ")}`);
  const staged = await runner.exec(ws, `${GIT} diff --cached --quiet`, T);
  if (staged.exitCode === 0) return false;
  await git(runner, ws, `commit -q -m ${shq(message)}`);
  return true;
}

/** Switch to `branch`, creating it from `from` if it does not exist. */
export async function checkoutBranch(runner: Runner, ws: Workspace, branch: string, from = "main"): Promise<void> {
  const exists = await runner.exec(ws, `git rev-parse --verify --quiet refs/heads/${shq(branch)}`, T);
  await git(runner, ws, exists.exitCode === 0 ? `switch -q ${shq(branch)}` : `switch -q -c ${shq(branch)} ${shq(from)}`);
}

/** True when `rev..HEAD` changes any file. */
export async function changedSince(runner: Runner, ws: Workspace, rev: string): Promise<boolean> {
  const r = await runner.exec(ws, `git diff --quiet ${shq(rev)} HEAD --`, T);
  return r.exitCode !== 0;
}

/**
 * Run `fn` with the tree checked out at `rev` (detached), then go back to
 * `back`. The tree must be clean (work committed). Whatever `fn` changed is
 * thrown away: tracked files are reset and untracked files it created are
 * removed; ignored files that already existed (node_modules, build output) stay.
 */
export async function atRevision<T>(runner: Runner, ws: Workspace, rev: string, back: string, fn: () => Promise<T>): Promise<T> {
  const untracked = async () => new Set((await git(runner, ws, "ls-files --others --exclude-standard --directory", 100_000)).split("\n").filter(Boolean));
  await git(runner, ws, `checkout -q -f --detach ${shq(rev)}`);
  const before = await untracked();
  try {
    return await fn();
  } finally {
    await git(runner, ws, "reset -q --hard");
    const created = [...(await untracked())].filter((p) => !before.has(p));
    if (created.length) await git(runner, ws, `clean -fdq -- ${created.map(shq).join(" ")}`);
    await git(runner, ws, `checkout -q -f ${shq(back)}`);
  }
}

/** Keep `pattern` out of git in this clone only (`.git/info/exclude`), without touching the repo's .gitignore. */
export function ensureLocalExclude(repoPath: string, pattern: string): void {
  const info = join(repoPath, ".git", "info");
  if (!existsSync(join(repoPath, ".git")) || !statSync(join(repoPath, ".git")).isDirectory()) return; // not a plain clone (e.g. a worktree)
  const file = join(info, "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(pattern)) return;
  if (!existsSync(info)) mkdirSync(info, { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

export async function headSha(runner: Runner, ws: Workspace): Promise<string> {
  return git(runner, ws, "rev-parse HEAD");
}

/**
 * Generated files that are listed in --stat but left out of the patch: a
 * lockfile alone can be thousands of lines and push the real code out of the
 * reviewer's budget (seen in the pilot: 5k-line package-lock.json).
 */
export const REVIEW_PATCH_EXCLUDES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "*.min.js",
  "*.map",
  "*.snap",
];

/** `git diff --stat` plus the patch, cut to `maxLines` lines (the reviewer sees what changed, not everything). */
export async function diffForReview(runner: Runner, ws: Workspace, base: string, head = "HEAD", maxLines = 1_500): Promise<string> {
  const range = `${shq(base)}..${shq(head)}`;
  const stat = await git(runner, ws, `diff --stat ${range}`, 500);
  const excludes = REVIEW_PATCH_EXCLUDES.map((p) => shq(`:(exclude,glob)**/${p}`)).join(" ");
  const r = await runner.exec(ws, `${GIT} diff --no-color ${range} -- . ${excludes} | head -n ${maxLines + 1}`, { ...T, tailLines: maxLines + 1 });
  const lines = r.outputTail.split("\n");
  const patch = lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… (diff truncated at ${maxLines} lines; see --stat above)` : r.outputTail;
  const note = `_(lockfiles and generated files such as ${REVIEW_PATCH_EXCLUDES.slice(0, 3).join(", ")} are listed above but omitted from the patch)_`;
  return `### Files changed\n\n\`\`\`\n${stat || "(no changes)"}\n\`\`\`\n\n### Diff\n\n${note}\n\n\`\`\`diff\n${patch}\n\`\`\``;
}

/** Merge `branch` into `into` with a merge commit; leaves `into` checked out. */
export async function mergeBranch(runner: Runner, ws: Workspace, branch: string, into: string, message: string): Promise<void> {
  await git(runner, ws, `switch -q ${shq(into)}`);
  await git(runner, ws, `merge --no-ff -q -m ${shq(message)} ${shq(branch)}`);
}

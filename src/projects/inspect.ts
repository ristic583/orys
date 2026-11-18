/**
 * Look at an existing repository before Orys takes it on (SPEC §17.4):
 * is it a usable git repo, which branch is the owner on, is the tree clean,
 * and what kind of project is it (so the wizard can suggest verify commands).
 */
import { execa } from "execa";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export type RepoInspection = {
  /** Absolute, normalized path. */
  path: string;
  name: string;
  exists: boolean;
  isGit: boolean;
  branch: string | null;
  clean: boolean;
  /** `git status --porcelain` lines (first 20). */
  dirty: string[];
  commits: number;
  lastCommit: { subject: string; date: string } | null;
  remotes: string[];
  trackedFiles: number;
  detected: {
    stacks: string[];
    packageManager: string | null;
    scripts: Record<string, string>;
    hasTests: boolean;
    hasCi: boolean;
    hasDocker: boolean;
  };
  suggestedVerify: string[];
  /** Reasons the repo cannot be used yet. */
  problems: string[];
  warnings: string[];
};

export function expandPath(p: string): string {
  const t = p.trim();
  return resolve(t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t);
}

const STACK_FILES: [string, string][] = [
  ["package.json", "Node.js"],
  ["tsconfig.json", "TypeScript"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["Gemfile", "Ruby"],
  ["pom.xml", "Java"],
  ["build.gradle", "Java/Kotlin"],
  ["build.gradle.kts", "Kotlin"],
  ["composer.json", "PHP"],
  ["mix.exs", "Elixir"],
  ["pubspec.yaml", "Dart/Flutter"],
];

/** Read-only git: GIT_OPTIONAL_LOCKS=0 keeps even `git status` from refreshing the owner's index. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await execa("git", args, { cwd, reject: false, env: { GIT_OPTIONAL_LOCKS: "0" } });
  return r.exitCode === 0 ? String(r.stdout).trim() : null;
}

/**
 * Inspect `input`. `taken` maps repo paths already used by other projects to their slug.
 * With `forCopy` (test mode), only a missing folder or Orys's own folder are problems:
 * everything else becomes a warning, because agents will work on a copy.
 */
export async function inspectRepo(input: string, opts: { taken?: Map<string, string>; aipmRoot?: string; forCopy?: boolean } = {}): Promise<RepoInspection> {
  let path = expandPath(input);
  const out: RepoInspection = {
    path,
    name: basename(path),
    exists: false,
    isGit: false,
    branch: null,
    clean: false,
    dirty: [],
    commits: 0,
    lastCommit: null,
    remotes: [],
    trackedFiles: 0,
    detected: { stacks: [], packageManager: null, scripts: {}, hasTests: false, hasCi: false, hasDocker: false },
    suggestedVerify: [],
    problems: [],
    warnings: [],
  };

  if (!input.trim()) {
    out.problems.push("Enter the path to the project folder.");
    return out;
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    out.problems.push("Folder not found.");
    return out;
  }
  out.exists = true;
  // Symlinks (e.g. /var → /private/var on macOS) must not make the same repo look different.
  path = realpathSync(path);
  out.path = path;
  if (opts.aipmRoot && !relative(opts.aipmRoot, path).startsWith("..")) out.problems.push("That is Orys's own folder.");
  const takenBy = opts.taken?.get(path);
  if (takenBy) out.problems.push(`Already used by project "${takenBy}".`);

  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (top === null) {
    out.problems.push("Not a git repository. Run `git init` and commit the current state first.");
  } else if (realpathSync(top) !== path) {
    out.problems.push(`This folder is inside the repository at ${top}. Use the repository root.`);
  } else {
    out.isGit = true;
    out.commits = Number(await git(path, ["rev-list", "--count", "HEAD"])) || 0;
    if (out.commits === 0) out.problems.push("The repository has no commits yet. Commit the current state first.");
    const branch = await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch) out.problems.push("HEAD is detached. Check out the branch you work on.");
    else out.branch = branch;
    if (branch?.startsWith("ai-pm/")) out.problems.push(`You are on Orys's own branch (${branch}). Check out your working branch.`);
    const status = (await git(path, ["status", "--porcelain"])) ?? "";
    out.dirty = status ? status.split("\n").slice(0, 20) : [];
    out.clean = out.dirty.length === 0;
    if (!out.clean) out.problems.push("There are uncommitted changes. Commit or stash them, so agents start from a known state.");
    const log = await git(path, ["log", "-1", "--format=%s%x1f%cI"]);
    if (log) {
      const [subject, date] = log.split("\x1f");
      out.lastCommit = { subject: subject ?? "", date: date ?? "" };
    }
    out.remotes = ((await git(path, ["remote"])) ?? "").split("\n").filter(Boolean);
    out.trackedFiles = ((await git(path, ["ls-files"])) ?? "").split("\n").filter(Boolean).length;
    if ((await git(path, ["rev-parse", "--verify", "--quiet", "refs/heads/ai-pm/main"])) !== null) {
      out.warnings.push("An ai-pm/main branch already exists; Orys will continue on it.");
    }
  }

  detect(path, out);
  if (!out.detected.hasTests) out.warnings.push("No tests found. The mapper will propose how to verify changes.");
  if (opts.forCopy) {
    const fatal: string[] = out.problems.filter((p) => p === "Folder not found." || p === "That is Orys's own folder.");
    const soft = out.problems.filter((p) => !fatal.includes(p)).map(copyNote);
    out.problems = fatal;
    out.warnings = [...soft, ...out.warnings.filter((w) => !w.startsWith("An ai-pm/main branch"))];
  }
  return out;
}

function detect(path: string, out: RepoInspection) {
  const has = (f: string) => existsSync(join(path, f));
  const d = out.detected;
  d.stacks = [...new Set(STACK_FILES.filter(([f]) => has(f)).map(([, s]) => s))];
  if (readdirSafe(path).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) d.stacks.push(".NET");
  d.hasCi = has(".github/workflows") || has(".gitlab-ci.yml") || has(".circleci");
  d.hasDocker = has("Dockerfile") || has("docker-compose.yml") || has("compose.yaml");
  d.hasTests = ["test", "tests", "__tests__", "spec"].some(has) || readdirSafe(join(path, "src")).some((f) => /\.(test|spec)\.[jt]sx?$/.test(f));

  if (has("package.json")) {
    d.packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    try {
      const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      d.scripts = pkg.scripts ?? {};
    } catch {
      out.warnings.push("package.json could not be parsed.");
    }
    const run = (s: string) => (d.packageManager === "npm" ? `npm run ${s}` : `${d.packageManager} run ${s}`);
    for (const s of ["typecheck", "build", "lint", "test"]) {
      if (d.scripts[s] && !/watch|--watch|serve|dev/.test(d.scripts[s]!)) out.suggestedVerify.push(s === "test" && d.packageManager === "npm" ? "npm test" : run(s));
    }
    if (d.scripts.test) d.hasTests = true;
  } else if (has("go.mod")) out.suggestedVerify.push("go build ./...", "go test ./...");
  else if (has("Cargo.toml")) out.suggestedVerify.push("cargo build", "cargo test");
  else if (d.stacks.includes("Python") && d.hasTests) out.suggestedVerify.push("python -m pytest -q");
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** How a would-be problem reads when agents only work on a copy. */
function copyNote(problem: string): string {
  if (problem.startsWith("Not a git repository")) return "Not a git repository: the copy gets its own fresh repository; your folder stays as it is.";
  if (problem.startsWith("There are uncommitted changes")) return "Uncommitted changes are included in the copy (snapshotted there); your folder stays as it is.";
  if (problem.startsWith("HEAD is detached")) return "Detached HEAD: the copy works on a new branch.";
  if (problem.startsWith("Already used by project")) return `${problem} That's fine for a copy.`;
  return `${problem.replace(/\.$/, "")} — fine for a copy.`;
}

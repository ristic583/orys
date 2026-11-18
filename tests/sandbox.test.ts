import { createHash } from "node:crypto";
import { execa } from "execa";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { NO_GIT } from "../src/loops/common.js";
import { runExecution } from "../src/loops/execution.js";
import { runPlanningToCompletion } from "../src/loops/planning.js";
import { BriefSchema } from "../src/projects/brief.js";
import { inspectRepo } from "../src/projects/inspect.js";
import { decideAfterMapping } from "../src/projects/ownerGate.js";
import { approvePlan } from "../src/projects/planEditor.js";
import { createProjectFromBrief, getProject, startProject } from "../src/projects/repo.js";
import { copyIntoSandbox } from "../src/projects/sandbox.js";
import { LocalRunner } from "../src/runner/local.js";
import { handoff, makeOwnerRepo, mapper, PLAN, planner, review, worker } from "./helpers.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "aipm-sbx-")));

/** Every file under `dir` (including .git) with its content hash and mtime: any write shows up. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const f = join(d, name);
      const st = statSync(f);
      if (st.isDirectory()) walk(f);
      else out.push(`${relative(dir, f)} ${st.mtimeMs} ${createHash("sha1").update(readFileSync(f)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

/** An owner repo with a remote, a pre-commit hook, uncommitted work and installed dependencies. */
async function messyOwnerRepo(root: string) {
  const repo = await makeOwnerRepo(join(root, "owner"), { "README.md": "# Owner\n", ".gitignore": "node_modules/\n.env\n" });
  await repo.git("remote", "add", "origin", "git@example.com:owner/app.git");
  writeFileSync(join(repo.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(repo.dir, "README.md"), "# Owner\n\nunsaved edit\n");
  writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");
  mkdirSync(join(repo.dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo.dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return repo;
}

describe("copyIntoSandbox", () => {
  it("copies without touching the original: no remotes, hooks off, uncommitted work snapshotted", async () => {
    const root = tmp();
    const repo = await messyOwnerRepo(root);
    const before = fingerprint(repo.dir);
    const r = await copyIntoSandbox(repo.dir, join(root, "copy"));
    expect(fingerprint(repo.dir)).toBe(before);

    const g = (...a: string[]) => execa("git", a, { cwd: r.path }).then((x) => x.stdout);
    expect(r).toMatchObject({ baseBranch: "trunk", initialized: false, snapshot: true, skipped: ["node_modules"] });
    expect(await g("remote")).toBe("");
    expect(await g("config", "core.hooksPath")).toBe("/dev/null");
    expect(await g("log", "--format=%s")).toBe("aipm: snapshot of uncommitted changes\nowner: initial");
    expect(readFileSync(join(r.path, "README.md"), "utf8")).toContain("unsaved edit");
    expect(existsSync(join(r.path, ".env"))).toBe(true); // copied for running, but ignored by git
    expect(await g("ls-files")).not.toContain(".env");
    expect(await g("status", "--porcelain")).toBe("");
    await expect(copyIntoSandbox(repo.dir, r.path)).rejects.toThrow(/already exists/);
  });

  it("a folder that is not a git repo gets a fresh repository only in the copy", async () => {
    const root = tmp();
    const src = join(root, "plain");
    mkdirSync(src);
    writeFileSync(join(src, "app.py"), "print(1)\n");
    const r = await copyIntoSandbox(src, join(root, "copy"));
    expect(existsSync(join(src, ".git"))).toBe(false);
    expect(r).toMatchObject({ baseBranch: "main", initialized: true, snapshot: true });
    expect((await execa("git", ["log", "--format=%s"], { cwd: r.path })).stdout).toBe(`aipm: snapshot of ${src}`);
  });

  it("never follows a .git file (worktree/submodule) back to the original's git directory", async () => {
    const root = tmp();
    const repo = await makeOwnerRepo(join(root, "main-repo"));
    await repo.git("worktree", "add", "-q", join(root, "wt"), "-b", "feature");
    const before = fingerprint(repo.dir);
    const r = await copyIntoSandbox(join(root, "wt"), join(root, "copy"));
    expect(r.initialized).toBe(true);
    expect(statSync(join(r.path, ".git")).isDirectory()).toBe(true);
    expect(fingerprint(repo.dir)).toBe(before);
  });
});

describe("test-mode projects", () => {
  it("inspection treats a dirty, non-git or taken folder as fine for a copy", async () => {
    const root = tmp();
    const repo = await messyOwnerRepo(root);
    const inPlace = await inspectRepo(repo.dir);
    expect(inPlace.problems.join(" ")).toMatch(/uncommitted changes/);
    const forCopy = await inspectRepo(repo.dir, { forCopy: true });
    expect(forCopy.problems).toEqual([]);
    expect(forCopy.warnings.join(" ")).toMatch(/included in the copy/);
    expect(() => BriefSchema.parse({ slug: "x1", name: "X", problem: "A new thing to build.", workspace: "sandbox" })).toThrow(/only applies to existing/);
  });

  it("the whole flow runs on the copy; agents may not run git; the original is byte-for-byte unchanged", async () => {
    const root = tmp();
    const repo = await messyOwnerRepo(root);
    const before = fingerprint(repo.dir);
    const config = loadConfig({ AIPM_DB: ":memory:", AIPM_RUNS_DIR: join(root, "runs"), AIPM_PROJECTS_DIR: join(root, "projects"), AIPM_SANDBOX_DIR: join(root, "sandbox") });
    const db = openDb(":memory:");
    const claude = new FakeClaudeClient([
      mapper, review("approve"), planner(PLAN), review("approve"),
      worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve"), review("approve"),
      worker(["c.txt"]), review("approve"), review("approve"), handoff,
    ]);
    const deps = { db, runner: new LocalRunner(claude), config };
    const brief = BriefSchema.parse({ slug: "trial", name: "Trial", problem: "Try Orys on a copy of my app.", mode: "existing", repoPath: repo.dir, workspace: "sandbox", existing: { currentState: "A readme with an unsaved edit." } });
    let p = await createProjectFromBrief(db, brief, { projectsDir: config.AIPM_PROJECTS_DIR, defaultProfile: "balanced", sandboxDir: config.AIPM_SANDBOX_DIR });
    expect(p).toMatchObject({ workspace: "sandbox", sourcePath: repo.dir, repoPath: join(root, "sandbox", "trial"), baseBranch: "trunk" });

    p = startProject(db, p);
    await runPlanningToCompletion(deps, p.id);
    expect(claude.calls[0]!.disallowedTools).toEqual(expect.arrayContaining(NO_GIT));
    await decideAfterMapping(deps, p.id, { picked: ["P1"], notes: "" });
    await runPlanningToCompletion(deps, p.id);
    approvePlan(db, p.id);
    await runExecution(deps, p.id);
    expect(getProject(db, p.id).status).toBe("done");

    const workerCall = claude.calls[4]!;
    expect(workerCall.disallowedTools).toEqual(NO_GIT);
    expect(workerCall.prompt).toContain("Do **not** commit and do not run any `git` command");
    expect(workerCall.prompt).toContain("Work only inside the current directory");
    expect(workerCall.cwd).toBe(join(root, "sandbox", "trial"));

    // Orys committed the work in the copy; the original did not change at all.
    const copyLog = (await execa("git", ["log", "--first-parent", "--format=%s", "ai-pm/main"], { cwd: p.repoPath })).stdout;
    expect(copyLog.split("\n")[0]).toBe("merge: phase 2 — Two");
    expect(fingerprint(repo.dir)).toBe(before);
  });
});

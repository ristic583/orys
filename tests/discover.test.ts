import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRepos } from "../src/projects/discover.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeRepo(root: string, rel: string, when?: Date) {
  const repo = join(root, rel);
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (when) utimesSync(join(repo, ".git", "HEAD"), when, when);
  return repo;
}

describe("discoverRepos", () => {
  it("finds repos, newest first, and skips hidden, dependency, excluded and nested folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "orys-discover-"));
    dirs.push(root);
    const old = fakeRepo(root, "code/old-app", new Date("2025-01-01T00:00:00Z"));
    const fresh = fakeRepo(root, "Desktop/fresh-app", new Date("2026-11-01T00:00:00Z"));
    const worktree = join(root, "code/wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n");
    fakeRepo(root, "code/old-app/packages/inner"); // inside a repo: not listed separately
    fakeRepo(root, ".hidden/secret");
    fakeRepo(root, "code/x/node_modules/dep");
    fakeRepo(root, "aipm-sandbox/copy");
    fakeRepo(root, "a/b/c/d/e/f/too-deep");

    const { repos, truncated } = await discoverRepos({ roots: [root], exclude: [join(root, "aipm-sandbox")], maxDepth: 4 });
    expect(truncated).toBe(false);
    // A worktree's .git is a file, so it has no activity time and sorts last.
    expect(repos.map((r) => r.path)).toEqual([fresh, old, worktree]);
    expect(repos[0]).toMatchObject({ name: "fresh-app", lastActivity: "2026-11-01T00:00:00.000Z" });
  });

  it("stops at the time budget and says so", async () => {
    const root = mkdtempSync(join(tmpdir(), "orys-discover-"));
    dirs.push(root);
    for (let i = 0; i < 40; i++) mkdirSync(join(root, `d${i}`, "x"), { recursive: true });
    const r = await discoverRepos({ roots: [root], timeBudgetMs: -1 });
    expect(r).toEqual({ repos: [], truncated: true });
  });
});

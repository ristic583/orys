import { execa } from "execa";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { runExecution } from "../src/loops/execution.js";
import { BriefSchema } from "../src/projects/brief.js";
import { inspectRepo } from "../src/projects/inspect.js";
import { mergeIntoBase, MergeRefused } from "../src/projects/mergeBase.js";
import { createProjectFromBrief, getProject, RepoNotUsable, startProject } from "../src/projects/repo.js";
import { updateProjectSettings } from "../src/projects/settings.js";
import { handoff, makeOwnerRepo, review, setup, worker } from "./helpers.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "aipm-modes-")));
const opts = (dir: string) => ({ projectsDir: join(dir, "projects"), defaultProfile: "balanced" as const });

describe("brief per mode", () => {
  it("scratch needs no repo; existing and rework need a repo and their answers", () => {
    expect(BriefSchema.parse({ slug: "a1", name: "A", problem: "Something useful." }).mode).toBe("scratch");
    const base = { slug: "a2", name: "A", problem: "An app that already exists." };
    expect(() => BriefSchema.parse({ ...base, mode: "existing", existing: { currentState: "Half of the API is done." } })).toThrow(/repoPath/);
    expect(() => BriefSchema.parse({ ...base, mode: "existing", repoPath: "/x" })).toThrow(/answers for a project in progress/);
    expect(() => BriefSchema.parse({ ...base, mode: "rework", repoPath: "/x", rework: { kinds: [] } })).toThrow(/at least one kind/);
    const r = BriefSchema.parse({ ...base, mode: "rework", repoPath: "/x", rework: { kinds: ["tests", "refactor"], successCriteria: ["coverage ≥ 80%"] } });
    expect(r.rework).toMatchObject({ behaviorFrozen: true, scope: [] });
    expect(() => BriefSchema.parse({ ...base, repoPath: "/x" })).toThrow(/scratch project gets a new folder/);
  });
});

describe("inspectRepo", () => {
  it("reports a clean Node repo with its branch and suggested verify commands", async () => {
    const { dir } = await makeOwnerRepo(join(tmp(), "app"), {
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run", dev: "vite", lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
      "tests/a.test.ts": "",
      ".github/workflows/ci.yml": "",
    });
    const r = await inspectRepo(dir);
    expect(r).toMatchObject({ isGit: true, branch: "trunk", clean: true, commits: 1, problems: [] });
    expect(r.detected).toMatchObject({ stacks: ["Node.js"], packageManager: "pnpm", hasTests: true, hasCi: true });
    expect(r.suggestedVerify).toEqual(["pnpm run build", "pnpm run lint", "pnpm run test"]);
  });

  it("explains why a folder cannot be used", async () => {
    const root = tmp();
    expect((await inspectRepo(join(root, "missing"))).problems).toEqual(["Folder not found."]);
    mkdirSync(join(root, "plain"));
    expect((await inspectRepo(join(root, "plain"))).problems[0]).toMatch(/Not a git repository/);

    const { dir, git } = await makeOwnerRepo(join(root, "repo"));
    writeFileSync(join(dir, "wip.txt"), "unsaved");
    const dirty = await inspectRepo(dir);
    expect(dirty.clean).toBe(false);
    expect(dirty.problems.join(" ")).toMatch(/uncommitted changes/);

    await git("add", "-A");
    await git("commit", "-q", "-m", "wip");
    await git("switch", "-q", "--detach");
    expect((await inspectRepo(dir)).problems.join(" ")).toMatch(/detached/);

    await git("switch", "-q", "trunk");
    mkdirSync(join(dir, "sub"));
    expect((await inspectRepo(join(dir, "sub"))).problems.join(" ")).toMatch(/inside the repository/);
    expect((await inspectRepo(dir, { taken: new Map([[dir, "other"]]) })).problems).toEqual(['Already used by project "other".']);
  });
});

describe("existing repository projects", () => {
  it("are created in place, remember the base branch, and start with the mapper", async () => {
    const root = tmp();
    const { dir } = await makeOwnerRepo(join(root, "shop"));
    const db = openDb(":memory:");
    const brief = BriefSchema.parse({
      slug: "shop", name: "Shop", problem: "An online shop for my bakery.", mode: "existing", repoPath: dir,
      existing: { currentState: "Catalog works; checkout is missing.", offLimits: ["infra/"], verifyCommands: ["npm test"] },
    });
    const p = await createProjectFromBrief(db, brief, opts(root));
    expect(p).toMatchObject({ mode: "existing", repoPath: dir, baseBranch: "trunk", integrationBranch: "ai-pm/main", status: "draft" });
    expect(p.modeDetails.existing).toMatchObject({ offLimits: ["infra/"], nextGoals: "" });
    expect(startProject(db, p).status).toBe("mapping");

    // The same repo cannot be taken twice, and a dirty repo is refused with reasons.
    await expect(createProjectFromBrief(db, { ...brief, slug: "shop-2" }, opts(root))).rejects.toThrow(RepoNotUsable);
    const other = await makeOwnerRepo(join(root, "dirty"));
    writeFileSync(join(other.dir, "x"), "1");
    await expect(createProjectFromBrief(db, { ...brief, slug: "dirty", repoPath: other.dir }, opts(root))).rejects.toThrow(/uncommitted/);
  });

  it("run on ai-pm/* branches; the owner's branch only changes on an explicit merge", async () => {
    const ctx = await setup(
      [worker(["a.txt"]), review("approve"), worker(["b.txt"]), review("approve"), review("approve"), worker(["c.txt"]), review("approve"), review("approve"), handoff],
      { mode: "existing" },
    );
    const { db, deps, project, git } = ctx;
    expect(project).toMatchObject({ baseBranch: "trunk", integrationBranch: "ai-pm/main" });
    await runExecution(deps, project.id);
    expect(getProject(db, project.id).status).toBe("done");

    const branches = (await git("branch", "--format=%(refname:short)")).split("\n").sort();
    expect(branches).toEqual(["ai-pm/main", "ai-pm/phase-1-one", "ai-pm/phase-2-two", "trunk"]);
    expect(await git("log", "--format=%s", "trunk")).toBe("owner: initial");
    expect((await git("log", "--first-parent", "--format=%s", "ai-pm/main")).split("\n").slice(0, 2)).toEqual(["merge: phase 2 — Two", "merge: phase 1 — One"]);

    const r = await mergeIntoBase(deps, project.id);
    expect(r).toMatchObject({ merged: true, into: "trunk" });
    expect(await git("branch", "--show-current")).toBe("trunk");
    expect(await git("log", "-1", "--format=%s", "trunk")).toBe("merge: Orys work on demo");
    await expect(mergeIntoBase(deps, project.id)).rejects.toThrow(/nothing to merge/);
  });

  it("merging is refused while agents may be working, and a conflict changes nothing", async () => {
    const root = tmp();
    const { dir, git } = await makeOwnerRepo(join(root, "conf"), { "notes.md": "v1\n" });
    const db = openDb(":memory:");
    const { LocalRunner } = await import("../src/runner/local.js");
    const { FakeClaudeClient } = await import("../src/claude/client.js");
    const deps = { db, runner: new LocalRunner(new FakeClaudeClient([])) };
    const brief = BriefSchema.parse({ slug: "conf", name: "C", problem: "A project with notes.", mode: "existing", repoPath: dir, existing: { currentState: "Notes only, nothing more." } });
    let p = startProject(db, await createProjectFromBrief(db, brief, opts(root)));
    await expect(mergeIntoBase(deps, p.id)).rejects.toThrow(MergeRefused); // not paused
    p = updateProjectSettings(db, p.id, { paused: true });
    await expect(mergeIntoBase(deps, p.id, { busy: (id) => id === p.id })).rejects.toThrow(/working on this project/);

    // Diverging edits of the same line on both branches.
    await git("switch", "-q", "-c", "ai-pm/main");
    writeFileSync(join(dir, "notes.md"), "v2 by Orys\n");
    await git("commit", "-qam", "ai change");
    await git("switch", "-q", "trunk");
    writeFileSync(join(dir, "notes.md"), "v2 by owner\n");
    await git("commit", "-qam", "owner change");
    await expect(mergeIntoBase(deps, p.id)).rejects.toThrow(/conflicts; nothing was changed/);
    expect((await execa("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe("");
    expect(await git("log", "-1", "--format=%s").then((r) => r.stdout)).toBe("owner change");
  });
});

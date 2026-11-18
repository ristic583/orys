/**
 * The owner's explicit "Merge into <branch>" for projects in an existing repo
 * (SPEC §17.4): Orys's integration branch goes into the owner's base branch.
 */
import { GitError, isDirty, shq } from "../git/index.js";
import type { LoopDeps } from "../loops/common.js";
import { ws } from "../loops/common.js";
import { getProject, logEvent } from "./repo.js";

export class MergeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeRefused";
  }
}

const T = { timeoutMs: 60_000 };

export async function mergeIntoBase(deps: Pick<LoopDeps, "db" | "runner">, idOrSlug: string, opts: { busy?: (projectId: string) => boolean } = {}) {
  const project = getProject(deps.db, idOrSlug);
  if (project.mode === "scratch" || !project.baseBranch) throw new MergeRefused("only projects in an existing repository have a base branch to merge into");
  if (opts.busy?.(project.id)) throw new MergeRefused("agents are working on this project right now; pause it first");
  if (project.status !== "done" && !project.paused) throw new MergeRefused("pause the project (or let it finish) before merging");
  const w = ws(project);
  const run = (cmd: string) => deps.runner.exec(w, `git ${cmd}`, T);
  if (await isDirty(deps.runner, w)) throw new MergeRefused("the repository has uncommitted changes");
  const ahead = await run(`rev-list --count ${shq(project.baseBranch)}..${shq(project.integrationBranch)}`);
  if (ahead.exitCode !== 0) throw new MergeRefused(`branch ${project.integrationBranch} does not exist yet`);
  const commits = Number(ahead.outputTail.trim()) || 0;
  if (commits === 0) throw new MergeRefused(`nothing to merge: ${project.baseBranch} already has everything from ${project.integrationBranch}`);

  const sw = await run(`switch -q ${shq(project.baseBranch)}`);
  if (sw.exitCode !== 0) throw new GitError(`git switch ${project.baseBranch} failed: ${sw.outputTail.slice(-400)}`);
  const merge = await run(`merge --no-ff -q -m ${shq(`merge: Orys work on ${project.slug}`)} ${shq(project.integrationBranch)}`);
  if (merge.exitCode !== 0) {
    await run("merge --abort");
    throw new MergeRefused(`merge has conflicts; nothing was changed. Resolve by hand: git merge ${project.integrationBranch}\n${merge.outputTail.slice(-800)}`);
  }
  logEvent(deps.db, project.id, "merged_into_base", { into: project.baseBranch, from: project.integrationBranch, commits });
  return { merged: true, into: project.baseBranch, commits };
}

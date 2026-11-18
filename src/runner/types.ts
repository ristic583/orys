import type { ClaudeOutcome, ClaudeRequest } from "../claude/client.js";

/** Minimal project shape a runner needs. */
export type Workspace = { slug: string; repoPath: string };

export type ExecOpts = {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** How many trailing output lines to keep (default 200). */
  tailLines?: number;
};

export type ExecResult = {
  exitCode: number;
  /** stdout+stderr interleaved, truncated to the last lines. */
  outputTail: string;
  durationMs: number;
  timedOut: boolean;
};

/**
 * Where a project's code lives and runs (SPEC §6.1). MVP: LocalRunner.
 * Docker/remote runners implement the same interface later.
 */
export interface Runner {
  /** Create the project folder and git repo if missing. Idempotent. */
  ensureWorkspace(ws: Workspace): Promise<void>;
  /** Run a shell command inside the project (verify commands, git). */
  exec(ws: Workspace, command: string, opts: ExecOpts): Promise<ExecResult>;
  /** Run a Claude session inside the project. `cwd` is set by the runner. */
  runClaude(ws: Workspace, req: Omit<ClaudeRequest, "cwd">): Promise<ClaudeOutcome>;
}

import { execa } from "execa";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeClient, ClaudeOutcome, ClaudeRequest } from "../claude/client.js";
import type { ExecOpts, ExecResult, Runner, Workspace } from "./types.js";

export const OUTPUT_TAIL_LINES = 200;

export function tailLines(s: string, n = OUTPUT_TAIL_LINES): string {
  const lines = s.split("\n");
  return lines.length > n ? [`… (${lines.length - n} lines omitted)`, ...lines.slice(-n)].join("\n") : s;
}

const DEFAULT_GITIGNORE = ["node_modules/", ".env", ".env.*", "dist/", ".DS_Store", ""].join("\n");

/** Runs everything directly on this machine, in the project's folder. */
export class LocalRunner implements Runner {
  constructor(private readonly claude: ClaudeClient) {}

  async ensureWorkspace(ws: Workspace): Promise<void> {
    mkdirSync(ws.repoPath, { recursive: true });
    if (existsSync(join(ws.repoPath, ".git"))) return;
    const git = (...args: string[]) => execa("git", args, { cwd: ws.repoPath });
    await git("init", "-b", "main");
    if (!existsSync(join(ws.repoPath, ".gitignore"))) writeFileSync(join(ws.repoPath, ".gitignore"), DEFAULT_GITIGNORE);
    await git("add", "-A");
    // Identity is local to the repo so commits work regardless of global git config.
    await git("-c", "user.name=Orys", "-c", "user.email=orys@localhost", "commit", "-m", "chore: initialize workspace");
  }

  async exec(ws: Workspace, command: string, opts: ExecOpts): Promise<ExecResult> {
    const started = Date.now();
    const r = await execa(command, {
      shell: true,
      cwd: ws.repoPath,
      timeout: opts.timeoutMs,
      cancelSignal: opts.signal,
      env: { CI: "1", ...opts.env },
      all: true,
      reject: false,
      stdin: "ignore",
    });
    return {
      exitCode: r.exitCode ?? (r.timedOut ? 124 : -1),
      outputTail: tailLines(String(r.all ?? ""), opts.tailLines),
      durationMs: Date.now() - started,
      timedOut: !!r.timedOut,
    };
  }

  runClaude(ws: Workspace, req: Omit<ClaudeRequest, "cwd">): Promise<ClaudeOutcome> {
    return this.claude.run({ ...req, cwd: ws.repoPath });
  }
}

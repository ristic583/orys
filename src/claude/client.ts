import { execa } from "execa";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Effort, ErrorKind } from "../core/types.js";
import { StreamAccumulator, StreamLineSchema, classifyError, type ClaudeResult, type RateLimitInfo } from "./schema.js";
import type { z } from "zod";

export type StreamLine = z.infer<typeof StreamLineSchema>;

export type ClaudeRequest = {
  prompt: string;
  cwd: string;
  model: string;
  effort?: Effort;
  permissionMode?: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  timeoutMs: number;
  /** Full stream-json output goes here (one JSON message per line). */
  logPath: string;
  signal?: AbortSignal;
  onLine?: (line: StreamLine) => void;
};

export type ClaudeOutcome = {
  result?: ClaudeResult;
  lastRateLimit?: RateLimitInfo;
  sessionId?: string;
  exitCode: number;
  stderrTail: string;
  durationMs: number;
  /** null = success. */
  errorKind: ErrorKind | null;
  /** Stopped by our AbortSignal (shutdown): treat as an interrupt, not a failure. */
  aborted: boolean;
  /** Context size at the end of the run (0 when unknown). */
  contextTokens?: number;
};

export interface ClaudeClient {
  run(req: ClaudeRequest): Promise<ClaudeOutcome>;
}

/** Flags that isolate a session from the user's global MCP servers, hooks and settings (M0). */
export const ISOLATION_FLAGS = ["--strict-mcp-config", "--setting-sources", "project,local"] as const;

export function buildArgs(req: ClaudeRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", req.model, ...ISOLATION_FLAGS];
  if (req.effort) args.push("--effort", req.effort);
  if (req.permissionMode) args.push("--permission-mode", req.permissionMode);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
  if (req.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(req.maxBudgetUsd));
  // Variadic flag last so it cannot swallow other arguments.
  if (req.disallowedTools?.length) args.push("--disallowedTools", ...req.disallowedTools);
  return args;
}

const tail = (s: string, n = 4_000) => (s.length > n ? s.slice(-n) : s);

/** Runs the real `claude` CLI in headless stream-json mode. */
export class CliClaudeClient implements ClaudeClient {
  constructor(private readonly bin = "claude") {}

  async run(req: ClaudeRequest): Promise<ClaudeOutcome> {
    mkdirSync(dirname(req.logPath), { recursive: true });
    const log = createWriteStream(req.logPath);
    const acc = new StreamAccumulator(req.onLine);
    const started = Date.now();

    const child = execa(this.bin, buildArgs(req), {
      cwd: req.cwd,
      input: req.prompt,
      timeout: req.timeoutMs,
      cancelSignal: req.signal,
      reject: false,
      buffer: { stdout: false, stderr: true },
      // Workers must not inherit Orys's own config.
      env: { AIPM_DB: undefined, AIPM_PORT: undefined },
      // Own process group: signals the CLI sends to its group on shutdown must not reach Orys.
      // We stop it ourselves through cancelSignal.
      detached: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      log.write(chunk);
      acc.push(chunk);
    });

    const r = await child;
    acc.end();
    await new Promise<void>((res) => log.end(res));

    const exitCode = r.exitCode ?? -1;
    const stderrTail = tail(String(r.stderr ?? ""));
    let errorKind: ErrorKind | null;
    if (r.isCanceled) errorKind = null;
    else if (r.timedOut) errorKind = "timeout";
    else errorKind = classifyError(acc.result, { exitCode, stderr: stderrTail, lastRateLimit: acc.lastRateLimit });

    return {
      result: acc.result,
      lastRateLimit: acc.lastRateLimit,
      sessionId: acc.result?.session_id ?? acc.sessionId,
      exitCode,
      stderrTail,
      durationMs: Date.now() - started,
      errorKind,
      aborted: !!r.isCanceled,
      contextTokens: acc.contextTokens,
    };
  }
}

/**
 * Test double: each call takes the next scripted handler. Handlers receive
 * the request and return a (partial) outcome; defaults fill the rest.
 */
export type FakeHandler = (req: ClaudeRequest) => Partial<ClaudeOutcome> | Promise<Partial<ClaudeOutcome>>;

export class FakeClaudeClient implements ClaudeClient {
  readonly calls: ClaudeRequest[] = [];
  constructor(private readonly script: FakeHandler[]) {}

  /** Append more scripted responses. */
  enqueue(...handlers: FakeHandler[]): void {
    this.script.push(...handlers);
  }

  async run(req: ClaudeRequest): Promise<ClaudeOutcome> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) throw new Error(`FakeClaudeClient: no scripted response for call #${this.calls.length}`);
    const partial = await next(req);
    return { exitCode: 0, stderrTail: "", durationMs: 1, errorKind: null, aborted: false, ...partial };
  }

  /** Helper: a successful result with given text and token usage. */
  static ok(text: string, opts: { sessionId?: string; tokens?: number; rateLimit?: RateLimitInfo } = {}): Partial<ClaudeOutcome> {
    const sessionId = opts.sessionId ?? "fake-session";
    return {
      sessionId,
      lastRateLimit: opts.rateLimit,
      result: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        session_id: sessionId,
        num_turns: 1,
        duration_ms: 1,
        total_cost_usd: 0.001,
        usage: { input_tokens: opts.tokens ?? 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
  }

  /** Helper: a run rejected by the subscription limit. */
  static limited(resetsAt: number, type = "five_hour"): Partial<ClaudeOutcome> {
    return {
      exitCode: 1,
      errorKind: "limit",
      lastRateLimit: { status: "rejected", resetsAt, rateLimitType: type },
      result: { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", session_id: "fake-session", num_turns: 0, duration_ms: 0, total_cost_usd: 0 },
    };
  }
}

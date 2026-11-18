import { z } from "zod";

/**
 * Final `result` message from `claude -p --output-format json` (or the last
 * line of `stream-json`). Only fields Orys relies on are required; the rest
 * pass through so new CLI fields don't break parsing.
 */
export const ClaudeUsageSchema = z
  .object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().default(0),
  })
  .loose();

export const ClaudeResultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string(),
    num_turns: z.number().default(0),
    duration_ms: z.number().default(0),
    total_cost_usd: z.number().default(0),
    usage: ClaudeUsageSchema.optional(),
    terminal_reason: z.string().optional(),
    api_error_status: z.number().nullable().optional(),
    permission_denials: z.array(z.unknown()).optional(),
  })
  .loose();
export type ClaudeResult = z.infer<typeof ClaudeResultSchema>;

/**
 * `rate_limit_event` emitted in `stream-json` mode whenever the subscription
 * rate-limit state changes. `resetsAt` is a unix timestamp (seconds).
 */
export const RateLimitInfoSchema = z
  .object({
    status: z.string(), // "allowed" | "allowed_warning" | "rejected"
    resetsAt: z.number().nullable().optional(),
    rateLimitType: z.string().nullable().optional(), // "five_hour" | "seven_day" | ...
  })
  .loose();
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

export const RateLimitEventSchema = z
  .object({
    type: z.literal("rate_limit_event"),
    rate_limit_info: RateLimitInfoSchema,
  })
  .loose();

/** Any line of `stream-json` output; we only discriminate on `type`. */
export const StreamLineSchema = z.object({ type: z.string() }).loose();

import type { ErrorKind } from "../core/types.js";
export type { ErrorKind };

const LIMIT_PATTERNS = [
  /you've hit your .*limit/i,
  /you've reached your .*limit/i,
  /usage limit reached/i,
  /limit reached/i,
  /out of usage credits/i,
];
const AUTH_PATTERNS = [/failed to authenticate/i, /please run \/login/i, /invalid api key/i, /oauth/i];

/** Classify a finished run. Structured rate-limit info wins over text matching. */
export function classifyError(
  result: ClaudeResult | undefined,
  opts: { exitCode: number; stderr?: string; lastRateLimit?: RateLimitInfo },
): ErrorKind | null {
  if (opts.lastRateLimit?.status === "rejected") return "limit";
  if (!result) return opts.exitCode === 0 ? "parse" : "crash";
  if (!result.is_error && opts.exitCode === 0) return null;
  const text = `${result.result ?? ""}\n${opts.stderr ?? ""}`;
  if (AUTH_PATTERNS.some((p) => p.test(text))) return "auth";
  if (LIMIT_PATTERNS.some((p) => p.test(text))) return "limit";
  return "crash";
}

type StreamLine = z.infer<typeof StreamLineSchema>;

/**
 * Incremental stream-json parser: feed it chunks as they arrive, it keeps the
 * final result and the latest rate-limit info. Non-JSON lines are ignored
 * (MCP servers can log to stdout).
 */
export class StreamAccumulator {
  result?: ClaudeResult;
  lastRateLimit?: RateLimitInfo;
  sessionId?: string;
  /** Context size of the last model call (input + cache read + cache write): how big the session is now. */
  contextTokens = 0;
  lineCount = 0;
  private buf = "";

  constructor(private readonly onLine?: (line: StreamLine) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.handle(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  end(): void {
    if (this.buf) this.handle(this.buf);
    this.buf = "";
  }

  private handle(raw: string): void {
    const s = raw.trim();
    if (!s.startsWith("{")) return;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return;
    }
    const line = StreamLineSchema.safeParse(obj);
    if (!line.success) return;
    this.lineCount++;
    const sid = (line.data as { session_id?: unknown }).session_id;
    if (typeof sid === "string") this.sessionId = sid;
    if (line.data.type === "assistant") {
      const u = (obj as { message?: { usage?: Record<string, unknown> } }).message?.usage;
      if (u) {
        const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
        const size = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if (size > 0) this.contextTokens = size;
      }
    }
    if (line.data.type === "result") {
      const r = ClaudeResultSchema.safeParse(obj);
      if (r.success) this.result = r.data;
    } else if (line.data.type === "rate_limit_event") {
      const r = RateLimitEventSchema.safeParse(obj);
      if (r.success) this.lastRateLimit = r.data.rate_limit_info;
    }
    this.onLine?.(line.data);
  }
}

/** Parse complete stream-json (or json) output in one go. */
export function parseStream(stdout: string): { result?: ClaudeResult; lastRateLimit?: RateLimitInfo; lines: StreamLine[] } {
  const lines: StreamLine[] = [];
  const acc = new StreamAccumulator((l) => lines.push(l));
  acc.push(stdout);
  acc.end();
  return { result: acc.result, lastRateLimit: acc.lastRateLimit, lines };
}

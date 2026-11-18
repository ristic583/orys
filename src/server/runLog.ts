/** Turn a run's stream-json log into a compact transcript for the dashboard. */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";

export type LogEntry =
  | { kind: "init"; model: string | null; sessionId: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "tool_result"; text: string; isError: boolean }
  | { kind: "rate_limit"; status: string; utilization: number | null; resetsAt: number | null }
  | { kind: "result"; text: string; isError: boolean; costUsd: number | null; turns: number | null };

const MAX_ENTRIES = 1_500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s);

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: Block) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function summarizeRunLog(path: string | null): { entries: LogEntry[]; truncated: boolean; missing: boolean } {
  if (!path || !existsSync(path)) return { entries: [], truncated: false, missing: true };
  const entries: LogEntry[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(raw);
    } catch {
      continue; // non-JSON noise (e.g. MCP logs)
    }
    if (m.type === "system" && m.subtype === "init") entries.push({ kind: "init", model: m.model ?? null, sessionId: m.session_id ?? null });
    else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content as Block[]) {
        if (b.type === "text" && b.text?.trim()) entries.push({ kind: "text", text: clip(b.text, 4_000) });
        else if (b.type === "tool_use") entries.push({ kind: "tool", name: b.name ?? "?", input: clip(JSON.stringify(b.input ?? {}), 600) });
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content as Block[]) {
        if (b.type === "tool_result") entries.push({ kind: "tool_result", text: clip(contentText(b.content), 1_200), isError: !!b.is_error });
      }
    } else if (m.type === "rate_limit_event") {
      const i = m.rate_limit_info ?? {};
      entries.push({ kind: "rate_limit", status: String(i.status ?? "?"), utilization: i.utilization ?? null, resetsAt: i.resetsAt ?? null });
    } else if (m.type === "result") {
      entries.push({ kind: "result", text: clip(String(m.result ?? ""), 6_000), isError: !!m.is_error, costUsd: m.total_cost_usd ?? null, turns: m.num_turns ?? null });
    }
    if (entries.length >= MAX_ENTRIES) return { entries, truncated: true, missing: false };
  }
  return { entries, truncated: false, missing: false };
}

/**
 * What a running agent is doing right now, from the tail of its log: its last
 * tool call ("Edit Dashboard.tsx", "Bash: npm test") or, failing that, its last
 * line of text. Cheap enough to call on every status poll.
 */
export function currentActivity(path: string | null, tailBytes = 64 * 1024): { text: string; at: "tool" | "text" } | null {
  if (!path || !existsSync(path)) return null;
  const fd = openSync(path, "r");
  let chunk: string;
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    chunk = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = chunk.split("\n").reverse();
  for (const raw of lines) {
    let m: Record<string, any>;
    try {
      m = JSON.parse(raw);
    } catch {
      continue; // partial first line or noise
    }
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    const blocks = [...(m.message.content as Block[])].reverse();
    const tool = blocks.find((b) => b.type === "tool_use");
    if (tool) return { text: describeTool(tool.name ?? "?", (tool.input ?? {}) as Record<string, unknown>), at: "tool" };
    const text = blocks.find((b) => b.type === "text" && b.text?.trim());
    if (text) return { text: clip(text.text!.trim().split("\n")[0]!, 140), at: "text" };
  }
  return null;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (["Edit", "Write", "Read", "MultiEdit", "NotebookEdit"].includes(name) && (str("file_path") || str("notebook_path"))) return `${name} ${basename(str("file_path") || str("notebook_path"))}`;
  if (name === "Bash") return `Bash: ${clip(str("command").replace(/\s+/g, " "), 110)}`;
  if (name === "Grep" || name === "Glob") return `${name} ${clip(str("pattern"), 80)}`;
  if (name === "TodoWrite") return "updating its todo list";
  return name;
}

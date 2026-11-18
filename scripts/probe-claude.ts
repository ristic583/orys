/**
 * M0 probe: verifies how headless `claude -p` behaves on this machine and
 * records real outputs into fixtures/claude/ for tests.
 *
 *   pnpm probe               # all cases (a few cheap haiku calls)
 *   pnpm probe basic resume  # selected cases
 */
import { execa } from "execa";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeResultSchema, classifyError, parseStream } from "../src/claude/schema.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "claude");
mkdirSync(FIXTURES, { recursive: true });

type Outcome = { name: string; ok: boolean; note: string };
const outcomes: Outcome[] = [];

async function claude(args: string[], prompt: string, cwd: string) {
  const r = await execa("claude", ["-p", ...args], {
    input: prompt,
    cwd,
    reject: false,
    timeout: 180_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? -1 };
}

function save(name: string, content: string) {
  writeFileSync(join(FIXTURES, name), content.endsWith("\n") ? content : content + "\n");
}

/** `--output-format json` stdout can contain stray log lines (e.g. from MCP servers); use the last result line. */
function parseJson(stdout: string) {
  const result = parseStream(stdout).result;
  return result ? ClaudeResultSchema.safeParse(result) : undefined;
}

/** Flags that isolate a worker from the user's global MCP servers, hooks and settings. */
const ISOLATE = ["--strict-mcp-config", "--setting-sources", "project,local"];

const sandbox = () => mkdtempSync(join(tmpdir(), "aipm-probe-"));
const BASE = ["--model", "haiku", "--effort", "low"];
let basicSession: string | undefined;

const cases: Record<string, () => Promise<void>> = {
  async auth() {
    const r = await execa("claude", ["auth", "status"], { reject: false });
    const status = JSON.parse(r.stdout || "{}");
    if (!status.loggedIn) throw new Error("not logged in: run `claude auth login` and re-run the probe");
    outcomes.push({ name: "auth", ok: true, note: `authMethod=${status.authMethod}` });
  },

  async basic() {
    const r = await claude([...BASE, "--output-format", "json"], "Reply with exactly: ok", sandbox());
    save("basic.json", r.stdout);
    const p = parseJson(r.stdout);
    basicSession = p?.success ? p.data.session_id : undefined;
    const u = p?.success ? p.data.usage : undefined;
    const ctx = u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : -1;
    outcomes.push({
      name: "basic",
      ok: !!p?.success && !p.data.is_error && /ok/i.test(p.data.result ?? ""),
      note: p?.success ? `result=${JSON.stringify(p.data.result)} context tokens=${ctx}` : `unparsable, exit=${r.exitCode}`,
    });
  },

  async isolated() {
    const r = await claude([...BASE, ...ISOLATE, "--output-format", "json"], "Reply with exactly: ok", sandbox());
    save("isolated.json", r.stdout);
    const p = parseJson(r.stdout);
    const u = p?.success ? p.data.usage : undefined;
    const ctx = u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : -1;
    outcomes.push({
      name: "isolated",
      ok: !!p?.success && !p.data.is_error && /ok/i.test(p.data.result ?? ""),
      note: `context tokens=${ctx} (compare with basic) stdout_lines=${r.stdout.split("\n").length}`,
    });
  },

  async resume() {
    if (!basicSession) return void outcomes.push({ name: "resume", ok: false, note: "skipped: no basic session" });
    const r = await claude(
      [...BASE, "--output-format", "json", "--resume", basicSession],
      "What exact word did you reply with in your previous message? Answer with that word only.",
      sandbox(),
    );
    save("resume.json", r.stdout);
    const p = parseJson(r.stdout);
    outcomes.push({
      name: "resume",
      ok: !!p?.success && /ok/i.test(p.data.result ?? ""),
      note: p?.success
        ? `same session_id=${p.data.session_id === basicSession} result=${JSON.stringify(p.data.result)}`
        : `unparsable, exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`,
    });
  },

  async stream() {
    const r = await claude([...BASE, "--output-format", "stream-json", "--verbose"], "Reply with exactly: ok", sandbox());
    save("stream.jsonl", r.stdout);
    const s = parseStream(r.stdout);
    const types = [...new Set(s.lines.map((l) => l.type))].join(",");
    outcomes.push({
      name: "stream",
      ok: !!s.result && !s.result.is_error,
      note: `types=[${types}] rate_limit=${JSON.stringify(s.lastRateLimit ?? null)}`,
    });
  },

  async readonly() {
    const cwd = sandbox();
    const r = await claude(
      [...BASE, "--output-format", "json", "--permission-mode", "bypassPermissions", "--disallowedTools", "Edit", "Write", "NotebookEdit", "Bash"],
      "Create a file named probe.txt containing the word hello. Then say done.",
      cwd,
    );
    save("readonly.json", r.stdout);
    const created = existsSync(join(cwd, "probe.txt"));
    outcomes.push({ name: "readonly", ok: !created, note: `file created=${created} exit=${r.exitCode}` });
  },

  async planMode() {
    const cwd = sandbox();
    const r = await claude(
      [...BASE, "--output-format", "json", "--permission-mode", "plan"],
      "Create a file named probe.txt containing hello, then reply with a one-line review verdict: approve.",
      cwd,
    );
    save("plan-mode.json", r.stdout);
    const p = parseJson(r.stdout);
    const created = existsSync(join(cwd, "probe.txt"));
    outcomes.push({
      name: "planMode",
      ok: !!p?.success && !p.data.is_error && !created,
      note: p?.success ? `file created=${created} result=${JSON.stringify((p.data.result ?? "").slice(0, 120))}` : `unparsable, exit=${r.exitCode}`,
    });
  },

  async badModel() {
    const r = await claude(["--model", "no-such-model-xyz", "--output-format", "json"], "ok", sandbox());
    save("bad-model.json", r.stdout || JSON.stringify({ stderr: r.stderr, exitCode: r.exitCode }));
    const p = parseJson(r.stdout);
    const kind = classifyError(p?.success ? p.data : undefined, { exitCode: r.exitCode, stderr: r.stderr });
    outcomes.push({ name: "badModel", ok: kind === "crash", note: `exit=${r.exitCode} classified=${kind}` });
  },
};

const selected = process.argv.slice(2);
const order = ["auth", ...(selected.length ? selected.filter((c) => c !== "auth") : Object.keys(cases).filter((c) => c !== "auth"))];

for (const name of order) {
  const fn = cases[name];
  if (!fn) throw new Error(`unknown case: ${name}`);
  process.stdout.write(`… ${name}\n`);
  try {
    await fn();
  } catch (e) {
    outcomes.push({ name, ok: false, note: (e as Error).message });
    if (name === "auth") break;
  }
}

console.log("\nProbe results:");
for (const o of outcomes) console.log(`${o.ok ? "PASS" : "FAIL"}  ${o.name.padEnd(9)} ${o.note}`);
process.exitCode = outcomes.every((o) => o.ok) ? 0 : 1;

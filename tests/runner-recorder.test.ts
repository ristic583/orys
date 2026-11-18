import { execa } from "execa";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient, buildArgs } from "../src/claude/client.js";
import { isBlocked } from "../src/claude/limits.js";
import { openDb, schema } from "../src/db/index.js";
import { LocalRunner, tailLines } from "../src/runner/local.js";
import { loadLimit } from "../src/runs/limitStore.js";
import { recordClaudeRun } from "../src/runs/recorder.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aipm-test-"));

describe("buildArgs", () => {
  it("always isolates, puts variadic disallowedTools last", () => {
    const args = buildArgs({
      prompt: "x", cwd: "/", model: "sonnet", effort: "low", resumeSessionId: "s1",
      disallowedTools: ["Edit", "Write"], permissionMode: "bypassPermissions", timeoutMs: 1, logPath: "/tmp/x",
    });
    expect(args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--model"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args.join(" ")).toContain("--resume s1");
    expect(args.slice(-3)).toEqual(["--disallowedTools", "Edit", "Write"]);
  });
});

describe("LocalRunner", () => {
  it("initializes a git workspace idempotently and runs shell commands", async () => {
    const runner = new LocalRunner(new FakeClaudeClient([]));
    const ws = { slug: "t", repoPath: join(tmp(), "proj") };
    await runner.ensureWorkspace(ws);
    await runner.ensureWorkspace(ws);
    expect(existsSync(join(ws.repoPath, ".gitignore"))).toBe(true);
    const log = await execa("git", ["log", "--oneline"], { cwd: ws.repoPath });
    expect(log.stdout.split("\n")).toHaveLength(1);

    const ok = await runner.exec(ws, "echo hello && echo err 1>&2", { timeoutMs: 10_000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.outputTail).toContain("hello");
    expect(ok.outputTail).toContain("err");

    const fail = await runner.exec(ws, "exit 3", { timeoutMs: 10_000 });
    expect(fail.exitCode).toBe(3);

    const slow = await runner.exec(ws, "sleep 5", { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).not.toBe(0);
  });

  it("tails long output", () => {
    const out = tailLines(Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n"), 10);
    expect(out.split("\n")).toHaveLength(11);
    expect(out).toContain("290 lines omitted");
    expect(out.endsWith("l299")).toBe(true);
  });
});

describe("recordClaudeRun", () => {
  const setup = (script: ConstructorParameters<typeof FakeClaudeClient>[0]) => {
    const db = openDb(":memory:");
    const claude = new FakeClaudeClient(script);
    const deps = { db, runner: new LocalRunner(claude), config: { AIPM_RUNS_DIR: tmp(), AIPM_LIMIT_FALLBACK_MIN: 30 }, now: () => new Date("2026-11-09T12:00:00Z") };
    return { db, claude, deps, ws: { slug: "t", repoPath: tmp() } };
  };

  it("persists tokens, session and an event for a successful run", async () => {
    const { db, claude, deps, ws } = setup([() => FakeClaudeClient.ok("done", { sessionId: "s42", tokens: 1234 })]);
    const { run } = await recordClaudeRun(deps, ws, { kind: "probe" }, { prompt: "hi", model: "haiku", timeoutMs: 1000 });

    expect(run).toMatchObject({ kind: "probe", sessionId: "s42", inputTokens: 1234, isError: false, errorKind: null, resultText: "done" });
    expect(run.endedAt).toBeInstanceOf(Date);
    expect(claude.calls[0]!.cwd).toBe(ws.repoPath);
    expect(claude.calls[0]!.logPath).toContain(run.id);
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });

  it("marks the global limit state when a run hits the limit", async () => {
    const resetsAt = Math.floor(new Date("2026-11-09T15:00:00Z").getTime() / 1000);
    const { db, deps, ws } = setup([() => FakeClaudeClient.limited(resetsAt)]);
    const { run } = await recordClaudeRun(deps, ws, { kind: "probe" }, { prompt: "hi", model: "haiku", timeoutMs: 1000 });

    expect(run.errorKind).toBe("limit");
    const limit = loadLimit(db);
    expect(limit).toMatchObject({ status: "limited", rateLimitType: "five_hour" });
    expect(isBlocked(limit, new Date("2026-11-09T12:00:00Z")).until).toEqual(new Date("2026-11-09T15:00:00Z"));
  });

  it("does not touch the limit state when the run was aborted", async () => {
    const { db, deps, ws } = setup([() => ({ aborted: true, exitCode: -1 })]);
    await recordClaudeRun(deps, ws, { kind: "probe" }, { prompt: "hi", model: "haiku", timeoutMs: 1000 });
    expect(loadLimit(db).status).toBe("ok");
  });

  it("records a crash when the client throws", async () => {
    const { db, deps, ws } = setup([]);
    await expect(recordClaudeRun(deps, ws, { kind: "probe" }, { prompt: "hi", model: "haiku", timeoutMs: 1000 })).rejects.toThrow();
    expect(db.select().from(schema.runs).get()).toMatchObject({ errorKind: "crash", isError: true });
  });
});

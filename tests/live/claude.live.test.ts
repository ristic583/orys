/**
 * Live integration test against the real `claude` CLI. Costs a few cents of
 * subscription usage, so it only runs with AIPM_LIVE=1:
 *
 *   AIPM_LIVE=1 pnpm test:live
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliClaudeClient } from "../../src/claude/client.js";
import { openDb } from "../../src/db/index.js";
import { LocalRunner } from "../../src/runner/local.js";
import { loadLimit } from "../../src/runs/limitStore.js";
import { recordClaudeRun } from "../../src/runs/recorder.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aipm-live-"));

describe.runIf(process.env.AIPM_LIVE === "1")("live claude -p", () => {
  it("records a real haiku run with tokens, session and live limit info", async () => {
    const db = openDb(":memory:");
    const runner = new LocalRunner(new CliClaudeClient());
    const deps = { db, runner, config: { AIPM_RUNS_DIR: tmp(), AIPM_LIMIT_FALLBACK_MIN: 30 } };
    const ws = { slug: "live", repoPath: tmp() };

    const first = await recordClaudeRun(deps, ws, { kind: "probe" }, { prompt: "Reply with exactly: ok", model: "haiku", effort: "low", timeoutMs: 120_000 });
    expect(first.run.errorKind).toBeNull();
    expect(first.run.resultText).toMatch(/ok/i);
    expect(first.run.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(first.run.inputTokens + first.run.cacheReadTokens + first.run.cacheCreationTokens).toBeGreaterThan(1000);
    expect(readFileSync(first.run.logPath!, "utf8")).toContain('"type":"result"');

    const limit = loadLimit(db);
    expect(["ok", "warning"]).toContain(limit.status);
    console.log("live limit state:", limit);

    const resumed = await recordClaudeRun(
      deps,
      ws,
      { kind: "probe" },
      { prompt: "What word did you reply with before? Answer with that word only.", model: "haiku", effort: "low", resumeSessionId: first.run.sessionId!, timeoutMs: 120_000 },
    );
    expect(resumed.run.sessionId).toBe(first.run.sessionId);
    expect(resumed.run.resultText).toMatch(/ok/i);
  }, 300_000);
});

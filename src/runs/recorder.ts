import { eq } from "drizzle-orm";
import { join } from "node:path";
import type { ClaudeOutcome, ClaudeRequest } from "../claude/client.js";
import { applyObservation } from "../claude/limits.js";
import type { Config } from "../config.js";
import { newId } from "../core/ids.js";
import type { RunKind } from "../core/types.js";
import type { Db } from "../db/index.js";
import { events, runs, type Run } from "../db/schema.js";
import type { Runner, Workspace } from "../runner/types.js";
import { loadLimit, saveLimit } from "./limitStore.js";

export type RunContext = {
  kind: RunKind;
  projectId?: string;
  phaseId?: string;
  taskId?: string;
};

export type RecordedRun = { run: Run; outcome: ClaudeOutcome };

export type RecorderDeps = {
  db: Db;
  runner: Runner;
  config: Pick<Config, "AIPM_RUNS_DIR" | "AIPM_LIMIT_FALLBACK_MIN">;
  now?: () => Date;
  /** Shutdown signal: aborts the running claude call (the step then reports an interrupt). */
  signal?: AbortSignal;
};

/**
 * Run one Claude session and persist everything about it: the `runs` row
 * (tokens, cost, error kind, log path), the global limit state, and an event.
 * This is the only way the rest of the app should call Claude.
 */
export async function recordClaudeRun(
  deps: RecorderDeps,
  ws: Workspace,
  ctx: RunContext,
  req: Omit<ClaudeRequest, "cwd" | "logPath">,
): Promise<RecordedRun> {
  const { db, runner, config } = deps;
  const now = deps.now ?? (() => new Date());
  const id = newId();
  const logPath = join(config.AIPM_RUNS_DIR, `${id}.jsonl`);

  db.insert(runs)
    .values({
      id,
      projectId: ctx.projectId,
      phaseId: ctx.phaseId,
      taskId: ctx.taskId,
      kind: ctx.kind,
      model: req.model,
      effort: req.effort,
      sessionId: req.resumeSessionId,
      startedAt: now(),
      logPath,
    })
    .run();

  let outcome: ClaudeOutcome;
  try {
    // Persist the session id as soon as the CLI announces it, so a hard kill can still resume the session.
    // A resumed session gets a new id (`--resume` forks), so this applies to resumed runs too.
    let sessionSaved = false;
    const onLine: ClaudeRequest["onLine"] = (line) => {
      const sid = (line as { session_id?: unknown }).session_id;
      if (!sessionSaved && typeof sid === "string") {
        sessionSaved = true;
        db.update(runs).set({ sessionId: sid }).where(eq(runs.id, id)).run();
      }
      req.onLine?.(line);
    };
    outcome = await runner.runClaude(ws, { ...req, logPath, onLine, signal: req.signal ?? deps.signal });
  } catch (err) {
    // Spawn failure (e.g. CLI missing): record it as a crash and rethrow.
    db.update(runs)
      .set({ endedAt: now(), isError: true, errorKind: "crash", resultText: String(err).slice(0, 2_000) })
      .where(eq(runs.id, id))
      .run();
    throw err;
  }

  const r = outcome.result;
  const u = r?.usage;
  const resultText = r?.result ?? (outcome.stderrTail || null);

  const run = db.transaction((tx) => {
    const updated = tx
      .update(runs)
      .set({
        endedAt: now(),
        sessionId: outcome.sessionId ?? req.resumeSessionId,
        exitCode: outcome.exitCode,
        isError: r?.is_error ?? outcome.errorKind !== null,
        errorKind: outcome.errorKind,
        resultText,
        costUsd: r?.total_cost_usd ?? 0,
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
        numTurns: r?.num_turns ?? 0,
        contextTokens: outcome.contextTokens ?? 0,
      })
      .where(eq(runs.id, id))
      .returning()
      .get();

    if (!outcome.aborted) {
      const next = applyObservation(
        loadLimit(tx),
        { errorKind: outcome.errorKind, lastRateLimit: outcome.lastRateLimit, text: resultText ?? undefined, reachedApi: !!r },
        now(),
        config.AIPM_LIMIT_FALLBACK_MIN,
      );
      saveLimit(tx, next);
    }

    tx.insert(events)
      .values({
        projectId: ctx.projectId,
        type: "run_finished",
        payload: { runId: id, kind: ctx.kind, taskId: ctx.taskId ?? null, errorKind: outcome.errorKind, aborted: outcome.aborted },
      })
      .run();
    return updated;
  });

  return { run, outcome };
}

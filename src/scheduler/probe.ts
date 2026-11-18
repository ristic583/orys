import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isBlocked } from "../claude/limits.js";
import { READ_ONLY_TOOLS, type LoopDeps } from "../loops/common.js";
import { loadLimit, markProbe } from "../runs/limitStore.js";
import { recordClaudeRun } from "../runs/recorder.js";

export const PROBE_PROMPT = "Reply with the single word OK.";

export type ProbeResult = { ok: boolean; reason?: string; until?: Date };

/**
 * The cheapest possible call (haiku, no tools) to learn whether the
 * subscription accepts work again. The recorder folds its rate_limit_event
 * (or error) into the limit state like any other run.
 */
export async function runProbe(deps: LoopDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => new Date());
  markProbe(deps.db, now());
  const repoPath = join(deps.config.AIPM_RUNS_DIR, "probe-workspace");
  mkdirSync(repoPath, { recursive: true });
  const { outcome } = await recordClaudeRun(
    deps,
    { slug: "_probe", repoPath },
    { kind: "probe" },
    { prompt: PROBE_PROMPT, model: "haiku", disallowedTools: READ_ONLY_TOOLS, timeoutMs: deps.config.timeouts.probe },
  );
  if (outcome.aborted) return { ok: false, reason: "probe aborted" };
  const b = isBlocked(loadLimit(deps.db), now());
  if (b.blocked) return { ok: false, reason: b.reason, until: b.until };
  if (outcome.errorKind) return { ok: false, reason: `probe ${outcome.errorKind}` };
  return { ok: true };
}

import { CliClaudeClient, type ClaudeClient } from "./claude/client.js";
import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db/index.js";
import type { LoopDeps } from "./loops/common.js";
import { LocalRunner } from "./runner/local.js";

export type App = LoopDeps & { db: Db; config: Config };

/** Wire up the real dependencies. Tests build LoopDeps by hand with a FakeClaudeClient. */
export function createApp(opts: { config?: Config; claude?: ClaudeClient } = {}): App {
  const config = opts.config ?? loadConfig();
  const db = openDb(config.AIPM_DB);
  const runner = new LocalRunner(opts.claude ?? new CliClaudeClient(process.env.AIPM_CLAUDE_BIN ?? "claude"));
  return { db, runner, config };
}

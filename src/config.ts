import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { PROFILES, type ProfileName } from "./core/profiles.js";

/** Orys's own repository root. */
export const AIPM_ROOT = resolve(import.meta.dirname, "..");
const ROOT = AIPM_ROOT;

const EnvSchema = z.object({
  AIPM_PROJECTS_DIR: z.string().default(join(homedir(), "aipm-projects")),
  /** Copies of existing repos for test-mode projects. */
  AIPM_SANDBOX_DIR: z.string().default(join(homedir(), "aipm-sandbox")),
  AIPM_PORT: z.coerce.number().int().positive().default(4317),
  AIPM_DB: z.string().default(join(ROOT, "data", "aipm.db")),
  AIPM_RUNS_DIR: z.string().default(join(ROOT, "data", "runs")),
  AIPM_DEFAULT_PROFILE: z.enum(Object.keys(PROFILES) as [ProfileName, ...ProfileName[]]).default("balanced"),
  AIPM_TICK_MS: z.coerce.number().int().positive().default(5_000),
  AIPM_LIMIT_FALLBACK_MIN: z.coerce.number().positive().default(30),
  /** Most projects running at the same time; 0 = no cap. Each project runs on its own (SPEC §9). */
  AIPM_MAX_PARALLEL: z.coerce.number().int().min(0).max(50).default(0),
  /** A project session larger than this (tokens of context) is replaced by a fresh one. */
  AIPM_SESSION_MAX_CONTEXT: z.coerce.number().int().positive().default(150_000),
  /** Where the wizard looks for git repositories (comma-separated; default: your home folder). */
  AIPM_REPO_ROOTS: z.string().default(homedir()).transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)),
  AIPM_REVIEW_DIFF_MAX_LINES: z.coerce.number().int().positive().default(1_500),
  /** Sketch first (SPEC §22.7): new projects start with a quick visible draft the owner reacts to. */
  AIPM_SKETCH_FIRST: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Language of the owner-facing summaries (outcome card, handoff). */
  AIPM_SUMMARY_LANGUAGE: z.string().default("English"),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** Per-kind timeout for a single `claude -p` call, in ms. */
  timeouts: Record<"mapper" | "architect" | "planner" | "worker" | "master_review" | "probe" | "designer" | "handoff" | "sketch", number>;
};

const MIN = 60_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    timeouts: { mapper: 30 * MIN, architect: 30 * MIN, planner: 20 * MIN, worker: 45 * MIN, master_review: 15 * MIN, probe: 2 * MIN, designer: 25 * MIN, handoff: 10 * MIN, sketch: 15 * MIN },
  };
}

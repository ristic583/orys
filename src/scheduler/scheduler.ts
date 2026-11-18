/**
 * The scheduler (SPEC §9). Projects run in parallel and independently: every
 * runnable project gets its own loop that advances it step by step, so a slow
 * project never holds up another one. The subscription limit stays global:
 * the main loop waits it out and probes (one probe at a time), and project
 * loops do not start a step while it is blocked. Pausing a project aborts its
 * running claude call (task → interrupted, no attempt used). All state lives
 * in the database, so a stopped or killed process resumes where it left off.
 */
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { isBlocked } from "../claude/limits.js";
import { lastProbeAt, loadLimit, markProbe } from "../runs/limitStore.js";
import { projects, runs } from "../db/schema.js";
import type { LoopDeps, StepResult } from "../loops/common.js";
import { advanceExecution, recoverInFlight, recoverProject } from "../loops/execution.js";
import { advancePlanning } from "../loops/planning.js";
import { applyProjectEvent, getProject, logEvent } from "../projects/repo.js";
import { runProbe } from "./probe.js";
import { rankCandidates, type Candidate, type Scored } from "./score.js";

const WINDOW_MS = 7 * 864e5;
const RUNNABLE = ["sketching", "mapping", "architecting", "planning", "executing"] as const;

export type SchedulerOptions = {
  tickMs?: number;
  now?: () => Date;
  /** Minimum gap between limit probes after the reset time passed. */
  probeIntervalMs?: number;
  /** How often to check whether the CLI was logged in again. */
  authProbeIntervalMs?: number;
  /** Unexpected exceptions in a row before the project is blocked. */
  maxConsecutiveErrors?: number;
  /** Most projects running at the same time; 0 = no cap (AIPM_MAX_PARALLEL). */
  maxParallel?: number;
  /** How often a running project checks whether the owner paused it. */
  pauseCheckMs?: number;
};

export type CurrentJob = { projectId: string; slug: string; stage: "mapping" | "planning" | "execution"; startedAt: Date };

export type TickResult =
  | { kind: "ran"; projectId: string; slug: string; step: StepResult }
  | { kind: "waiting"; reason: string; until?: Date }
  | { kind: "probed"; ok: boolean; reason?: string; until?: Date }
  | { kind: "idle" }
  | { kind: "stopped" };

export class Scheduler {
  /** What each project is doing right now (one step at a time per project). */
  readonly jobs = new Map<string, CurrentJob>();
  private readonly ac = new AbortController();
  /** Per-project abort (pause); child of the global one. */
  private readonly projectAc = new Map<string, AbortController>();
  /** Running project loops (`run()` only). */
  private readonly loops = new Map<string, Promise<void>>();
  /** Bumped by every step that did something; `run({ untilIdle })` stops once it no longer moves. */
  private activity = 0;
  private readonly deps: LoopDeps;
  private readonly now: () => Date;
  private readonly errors = new Map<string, number>();
  private readonly opts: Required<Omit<SchedulerOptions, "now">>;

  constructor(deps: LoopDeps, opts: SchedulerOptions = {}) {
    this.now = opts.now ?? deps.now ?? (() => new Date());
    this.deps = { ...deps, now: this.now, signal: this.ac.signal };
    this.opts = {
      tickMs: opts.tickMs ?? deps.config.AIPM_TICK_MS,
      probeIntervalMs: opts.probeIntervalMs ?? 2 * 60_000,
      authProbeIntervalMs: opts.authProbeIntervalMs ?? 5 * 60_000,
      maxConsecutiveErrors: opts.maxConsecutiveErrors ?? 3,
      maxParallel: opts.maxParallel ?? deps.config.AIPM_MAX_PARALLEL,
      pauseCheckMs: opts.pauseCheckMs ?? 2_000,
    };
  }

  /** The first running job (older single-job view); see `jobs` for all of them. */
  get current(): CurrentJob | null {
    return this.jobs.values().next().value ?? null;
  }

  /** Is an agent working on this project right now? */
  busy(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  /** Abort the project's running claude call now (pause); its task becomes `interrupted`. */
  interrupt(projectId: string): boolean {
    const ac = this.projectAc.get(projectId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  get stopping(): boolean {
    return this.ac.signal.aborted;
  }

  /** Graceful stop: the running claude call is aborted (its task becomes `interrupted`); git and verify steps finish. */
  stop(): void {
    this.ac.abort();
  }

  /** Call once at startup, before the first tick. */
  recover(): number {
    return recoverInFlight(this.deps.db, this.now());
  }

  /** Projects that could get work, best first. */
  rank(): Scored[] {
    const { db } = this.deps;
    const now = this.now();
    const rows = db
      .select()
      .from(projects)
      .where(and(inArray(projects.status, [...RUNNABLE]), sql`${projects.paused} = 0`))
      .all();
    if (!rows.length) return [];
    const usage = db
      .select({
        projectId: runs.projectId,
        tokens: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens} + ${runs.cacheCreationTokens}), 0)`,
        last: sql<number | null>`max(${runs.endedAt})`,
      })
      .from(runs)
      .where(and(isNotNull(runs.projectId), gte(runs.startedAt, new Date(now.getTime() - WINDOW_MS))))
      .groupBy(runs.projectId)
      .all();
    const byId = new Map(usage.map((u) => [u.projectId, u]));
    const cands: Candidate[] = rows.map((p) => {
      const u = byId.get(p.id);
      return {
        id: p.id,
        slug: p.slug,
        priority: p.priority,
        deadline: p.deadline,
        createdAt: p.createdAt,
        tokens: u?.tokens ?? 0,
        lastRunAt: u?.last != null ? new Date(u.last) : null,
      };
    });
    return rankCandidates(cands, now);
  }

  async tick(): Promise<TickResult> {
    if (this.stopping) return { kind: "stopped" };
    const ranked = this.rank();
    if (!ranked.length) return { kind: "idle" };

    const gate = await this.limitGate();
    if (gate) return gate;

    for (const c of ranked) {
      if (this.stopping) return { kind: "stopped" };
      if (this.busy(c.id)) continue;
      const step = await this.step(c);
      // Nothing to do there (e.g. paused mid-way, waiting on a blocked phase): try the next project.
      if (step.status === "idle") continue;
      return { kind: "ran", projectId: c.id, slug: c.slug, step };
    }
    return { kind: "idle" };
  }

  /**
   * Run until stopped: every runnable project gets its own loop, all at the
   * same time (up to `maxParallel`). With `untilIdle`, return once no project
   * has work left.
   */
  async run(opts: { untilIdle?: boolean; onTick?: (r: TickResult) => void } = {}): Promise<void> {
    const recovered = this.recover();
    if (recovered) logEvent(this.deps.db, null, "scheduler_recovered", { tasks: recovered });
    const nap = () => sleep(this.opts.tickMs, undefined, { signal: this.ac.signal }).catch(() => undefined);
    while (!this.stopping) {
      const gate = await this.limitGate();
      if (gate) {
        opts.onTick?.(gate);
        if (!(gate.kind === "probed" && gate.ok)) await nap();
        continue;
      }
      const before = this.activity;
      for (const c of this.rank()) {
        if (this.loops.has(c.id)) continue;
        if (this.opts.maxParallel > 0 && this.loops.size >= this.opts.maxParallel) break;
        const loop = this.projectLoop(c, opts.onTick).finally(() => this.loops.delete(c.id));
        this.loops.set(c.id, loop);
      }
      if (!this.loops.size) {
        opts.onTick?.({ kind: "idle" });
        if (opts.untilIdle) break;
        await nap();
        continue;
      }
      await Promise.race([nap(), Promise.all(this.loops.values())]);
      if (opts.untilIdle && !this.loops.size && this.activity === before) {
        opts.onTick?.({ kind: "idle" });
        break;
      }
    }
    await Promise.allSettled([...this.loops.values()]);
  }

  /** Advance one project until it needs to wait (owner, limit, nothing runnable) or is paused or stopped. */
  private async projectLoop(c: Scored, onTick?: (r: TickResult) => void): Promise<void> {
    const { db } = this.deps;
    while (!this.stopping) {
      const limit = loadLimit(db);
      if (limit.authError || isBlocked(limit, this.now()).blocked) return; // the main loop waits and probes
      const p = getProject(db, c.id);
      if (p.paused || !(RUNNABLE as readonly string[]).includes(p.status)) return;
      const step = await this.step(c);
      if (step.status !== "idle") onTick?.({ kind: "ran", projectId: c.id, slug: c.slug, step });
      if (step.status === "progressed") continue;
      if (step.status === "failed") {
        await sleep(this.opts.tickMs, undefined, { signal: this.ac.signal }).catch(() => undefined);
        continue;
      }
      return;
    }
  }

  /** Returns a result when no work may start now. */
  private async limitGate(): Promise<TickResult | null> {
    const { db } = this.deps;
    const now = this.now();
    const limit = loadLimit(db);
    if (limit.authError && !lastProbeAt(db)) markProbe(db, now); // probing right away would just fail again
    const since = now.getTime() - (lastProbeAt(db)?.getTime() ?? 0);

    if (limit.authError) {
      if (since < this.opts.authProbeIntervalMs) return { kind: "waiting", reason: `auth: ${limit.authError} — run \`claude auth login\`` };
      return { kind: "probed", ...(await runProbe(this.deps)) };
    }
    if (limit.status === "limited") {
      if (limit.resetAt && limit.resetAt > now) return { kind: "waiting", reason: `limit (${limit.rateLimitType ?? "unknown"})`, until: limit.resetAt };
      // The reset time has passed: confirm with one cheap call before real work resumes.
      if (since < this.opts.probeIntervalMs) return { kind: "waiting", reason: "limit reset passed, next probe soon" };
      const res = await runProbe(this.deps);
      logEvent(db, null, "limit_probe", { ok: res.ok, reason: res.reason ?? null, until: res.until?.toISOString() ?? null });
      return { kind: "probed", ...res };
    }
    return null;
  }

  private async step(c: Scored): Promise<StepResult> {
    const { db } = this.deps;
    const project = getProject(db, c.id);
    const stage = project.status === "executing" ? "execution" : project.status === "mapping" ? "mapping" : "planning";
    this.jobs.set(project.id, { projectId: project.id, slug: project.slug, stage, startedAt: this.now() });
    const pac = new AbortController();
    this.projectAc.set(project.id, pac);
    const deps = { ...this.deps, signal: AbortSignal.any([this.ac.signal, pac.signal]) };
    // Pausing (dashboard or CLI, another process) aborts the running claude call instead of waiting for it.
    const watch = setInterval(() => {
      try {
        if (getProject(db, project.id).paused) pac.abort();
      } catch {
        pac.abort(); // project deleted
      }
    }, this.opts.pauseCheckMs);
    try {
      // Mapping, architecture and planning all live in the planning loop.
      const step = stage === "execution" ? await advanceExecution(deps, project.id) : await advancePlanning(deps, project.id);
      if (step.status !== "idle") this.activity++;
      this.errors.delete(project.id);
      logEvent(db, project.id, "scheduler_step", { stage, status: step.status, message: step.message, score: c.score });
      return step;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.activity++;
      // Do not leave a task stuck in `running`: this project runs one step at a time, so whatever runs in it is ours.
      recoverProject(db, project.id, this.now());
      const n = (this.errors.get(project.id) ?? 0) + 1;
      this.errors.set(project.id, n);
      logEvent(db, project.id, "scheduler_error", { stage, message: message.slice(0, 2_000), consecutive: n });
      if (n >= this.opts.maxConsecutiveErrors) {
        this.errors.delete(project.id);
        const p = getProject(db, project.id);
        if (p.status !== "blocked") applyProjectEvent(db, p, { type: "block", reason: `Orys hit an error ${n}× in a row: ${message}`.slice(0, 1_500) });
        return { status: "blocked", message: `${project.slug}: blocked after ${n} errors (${message})` };
      }
      return { status: "failed", message: `${project.slug}: ${message}` };
    } finally {
      clearInterval(watch);
      this.jobs.delete(project.id);
      this.projectAc.delete(project.id);
    }
  }
}

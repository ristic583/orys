/** Read models for the API (SPEC §10). Plain queries; no state changes. */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isBlocked } from "../claude/limits.js";
import type { DbOrTx } from "../db/index.js";
import { decisions, events, features, phases, projects, runs, tasks, verifications, type Project } from "../db/schema.js";
import { docPaths } from "../projects/docs.js";
import { phaseLock, taskLock } from "../projects/planEditor.js";
import { effectiveRoles } from "../loops/common.js";
import { listSlots, resumeCommand, slotOf } from "../sessions/slots.js";
import { getProject } from "../projects/repo.js";
import { lastProbeAt, loadLimit } from "../runs/limitStore.js";

const DAY = 864e5;
const tokenSum = sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens} + ${runs.cacheCreationTokens}), 0)`;

export function projectSummaries(db: DbOrTx, now = new Date()) {
  const rows = db.select().from(projects).orderBy(desc(projects.priority), asc(projects.createdAt)).all();
  const progress = db
    .select({
      projectId: phases.projectId,
      total: sql<number>`count(*)`,
      done: sql<number>`coalesce(sum(case when ${tasks.status} in ('done','skipped') then 1 else 0 end), 0)`,
      stuck: sql<number>`coalesce(sum(case when ${tasks.status} in ('failed','escalated') then 1 else 0 end), 0)`,
    })
    .from(tasks)
    .innerJoin(phases, eq(tasks.phaseId, phases.id))
    .groupBy(phases.projectId)
    .all();
  const usage = db
    .select({ projectId: runs.projectId, tokens: tokenSum, cost: sql<number>`coalesce(sum(${runs.costUsd}), 0)`, lastRunAt: sql<number | null>`max(${runs.endedAt})` })
    .from(runs)
    .where(and(isNotNull(runs.projectId), gte(runs.startedAt, new Date(now.getTime() - 7 * DAY))))
    .groupBy(runs.projectId)
    .all();
  const activePhase = db
    .select({ projectId: phases.projectId, idx: phases.idx, title: phases.title, status: phases.status })
    .from(phases)
    .where(inArray(phases.status, ["active", "reviewing", "blocked"]))
    .all();
  const phaseCount = db.select({ projectId: phases.projectId, n: sql<number>`count(*)` }).from(phases).groupBy(phases.projectId).all();
  // Every task's status in plan order: the dashboard draws one tick per task.
  const taskRows = db
    .select({ projectId: phases.projectId, status: tasks.status })
    .from(tasks)
    .innerJoin(phases, eq(tasks.phaseId, phases.id))
    .orderBy(asc(phases.idx), asc(tasks.idx))
    .all();
  return rows.map((p) => {
    const pr = progress.find((x) => x.projectId === p.id);
    const u = usage.find((x) => x.projectId === p.id);
    return {
      ...p,
      tasksTotal: pr?.total ?? 0,
      tasksDone: pr?.done ?? 0,
      tasksStuck: pr?.stuck ?? 0,
      taskStates: taskRows.filter((x) => x.projectId === p.id).map((x) => x.status),
      phasesTotal: phaseCount.find((x) => x.projectId === p.id)?.n ?? 0,
      currentPhase: activePhase.find((x) => x.projectId === p.id) ?? null,
      tokens7d: u?.tokens ?? 0,
      cost7d: u?.cost ?? 0,
      lastRunAt: u?.lastRunAt ? new Date(u.lastRunAt) : null,
    };
  });
}

export function projectDetail(db: DbOrTx, idOrSlug: string) {
  const p = getProject(db, idOrSlug);
  return {
    ...p,
    features: db.select().from(features).where(eq(features.projectId, p.id)).orderBy(desc(features.priority)).all(),
    effectiveRoles: effectiveRoles(p),
    session: sessionView(db, p),
  };
}

export function phasesWithTasks(db: DbOrTx, projectId: string) {
  const ph = db.select().from(phases).where(eq(phases.projectId, projectId)).orderBy(asc(phases.idx)).all();
  if (!ph.length) return [];
  const ts = db.select().from(tasks).where(inArray(tasks.phaseId, ph.map((x) => x.id))).orderBy(asc(tasks.idx)).all();
  const byId = new Map(ts.map((t) => [t.id, t.key]));
  const runStats = db
    .select({ taskId: runs.taskId, n: sql<number>`count(*)`, tokens: tokenSum })
    .from(runs)
    .where(inArray(runs.taskId, ts.map((t) => t.id)))
    .groupBy(runs.taskId)
    .all();
  return ph.map((phase) => ({
    ...phase,
    editable: phaseLock(phase, "edit") === null,
    deletable: phaseLock(phase, "delete") === null,
    canAddTasks: phaseLock(phase, "add_task") === null,
    lockedReason: phaseLock(phase, "delete"),
    tasks: ts
      .filter((t) => t.phaseId === phase.id)
      .map((t) => {
        const r = runStats.find((x) => x.taskId === t.id);
        const lockedReason = taskLock(t);
        return { ...t, dependsOnKeys: t.dependsOn.map((d) => byId.get(d) ?? d), runs: r?.n ?? 0, tokens: r?.tokens ?? 0, editable: lockedReason === null, lockedReason };
      }),
  }));
}

export function taskVerifications(db: DbOrTx, taskId: string) {
  return db.select().from(verifications).where(eq(verifications.taskId, taskId)).orderBy(desc(verifications.id)).limit(50).all();
}

export function projectDecisions(db: DbOrTx, projectId: string) {
  return db
    .select({ d: decisions, taskKey: tasks.key, phaseIdx: phases.idx })
    .from(decisions)
    .leftJoin(tasks, eq(decisions.taskId, tasks.id))
    .leftJoin(phases, eq(decisions.phaseId, phases.id))
    .where(eq(decisions.projectId, projectId))
    .orderBy(desc(decisions.id))
    .limit(200)
    .all()
    .map((r) => ({ ...r.d, taskKey: r.taskKey, phaseIdx: r.phaseIdx, by: r.d.runId ? "reviewer" : "owner" }));
}

export function listRuns(db: DbOrTx, filter: { projectId?: string; taskId?: string; limit?: number }) {
  const where = and(
    filter.projectId ? eq(runs.projectId, filter.projectId) : undefined,
    filter.taskId ? eq(runs.taskId, filter.taskId) : undefined,
  );
  return db
    .select({ r: runs, taskKey: tasks.key, projectSlug: projects.slug })
    .from(runs)
    .leftJoin(tasks, eq(runs.taskId, tasks.id))
    .leftJoin(projects, eq(runs.projectId, projects.id))
    .where(where)
    .orderBy(desc(runs.id))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all()
    .map(({ r, taskKey, projectSlug }) => ({ ...r, taskKey, projectSlug, resultText: r.resultText?.slice(0, 2_000) ?? null }));
}

/** Tokens per project, day and run kind over the last `days` days (local dates). */
export function usage(db: DbOrTx, days: number, now = new Date()) {
  const day = sql<string>`date(${runs.startedAt} / 1000, 'unixepoch', 'localtime')`;
  return db
    .select({
      day,
      projectSlug: sql<string>`coalesce(${projects.slug}, '(system)')`,
      kind: runs.kind,
      runs: sql<number>`count(*)`,
      tokens: tokenSum,
      cacheRead: sql<number>`coalesce(sum(${runs.cacheReadTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .leftJoin(projects, eq(runs.projectId, projects.id))
    .where(gte(runs.startedAt, new Date(now.getTime() - days * DAY)))
    .groupBy(day, projects.slug, runs.kind)
    .orderBy(day)
    .all();
}

export function limitStatus(db: DbOrTx, now = new Date()) {
  const limit = loadLimit(db);
  const b = isBlocked(limit, now);
  return { ...limit, lastProbeAt: lastProbeAt(db), blocked: b.blocked, blockedReason: b.reason ?? null, blockedUntil: b.until ?? null };
}

export function eventsAfter(db: DbOrTx, afterId: string | null, limit = 200) {
  return db
    .select({ e: events, projectSlug: projects.slug })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(afterId ? gt(events.id, afterId) : undefined)
    .orderBy(asc(events.id))
    .limit(limit)
    .all()
    .map((r) => ({ ...r.e, projectSlug: r.projectSlug }));
}

export function recentEvents(db: DbOrTx, projectId: string | null, limit = 100) {
  return db
    .select({ e: events, projectSlug: projects.slug })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(projectId ? eq(events.projectId, projectId) : undefined)
    .orderBy(desc(events.id))
    .limit(limit)
    .all()
    .map((r) => ({ ...r.e, projectSlug: r.projectSlug }));
}

export function latestEventId(db: DbOrTx): string | null {
  return db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get()?.id ?? null;
}

export const DOC_NAMES = ["architecture", "plan", "state", "goals"] as const;
export type DocName = (typeof DOC_NAMES)[number];
export const docPath = (project: Project, name: DocName) => {
  const d = docPaths(project);
  return { architecture: d.arch, plan: d.plan, state: d.state, goals: d.goals }[name];
};

/** A planning document from the project's working tree, or null if not written yet. */
export function readDoc(project: Project, name: DocName): string | null {
  const path = join(project.repoPath, docPath(project, name));
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** A project's session slot, as the dashboard shows it. */
export function sessionView(db: DbOrTx, p: Project) {
  const slot = slotOf(db, p.id);
  return slot ? { ...slot, resumeCommand: resumeCommand(p.repoPath, slot.sessionId) } : null;
}

export function sessionsOverview(db: DbOrTx, busy: (projectId: string) => boolean, maxContext: number) {
  const byId = new Map(db.select().from(projects).all().map((p) => [p.id, p]));
  return {
    maxContext,
    slots: listSlots(db).map((s) => {
      const p = s.projectId ? byId.get(s.projectId) : undefined;
      return {
        ...s,
        projectSlug: p?.slug ?? null,
        projectName: p?.name ?? null,
        resumeCommand: p ? resumeCommand(p.repoPath, s.sessionId) : null,
        /** An agent is using this session right now: do not open it interactively. */
        busy: !!p && busy(p.id),
      };
    }),
  };
}

/**
 * Project sessions (SPEC §17.7): one long-lived Claude session per project.
 * There is no pool: a project gets its session the first time a builder runs,
 * so a project never waits for another one. Builder runs (mapper/architect,
 * planner, workers) continue the project's session; reviews stay independent.
 * A session that grows past the context limit, or that can no longer be
 * resumed, is replaced by a fresh one. (Rows live in `session_slots`; `idx`
 * is only a display number.)
 */
import { asc, eq, isNull } from "drizzle-orm";
import type { ClaudeOutcome } from "../claude/client.js";
import type { DbOrTx } from "../db/index.js";
import { sessionSlots, type Project, type SessionSlot } from "../db/schema.js";
import { logEvent } from "../projects/repo.js";

export const listSlots = (db: DbOrTx) => db.select().from(sessionSlots).orderBy(asc(sessionSlots.idx)).all();
export const slotOf = (db: DbOrTx, projectId: string) => db.select().from(sessionSlots).where(eq(sessionSlots.projectId, projectId)).get();

export class SlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotError";
  }
}

/** The project's session row, created on first use (reusing a free leftover row, else a new one). Never fails. */
export function claimSlot(db: DbOrTx, project: Pick<Project, "id">): SessionSlot {
  const own = slotOf(db, project.id);
  if (own) return own;
  const fresh = { projectId: project.id, sessionId: null, contextTokens: 0, runs: 0, rotations: 0, assignedAt: new Date(), lastUsedAt: null };
  const free = db.select().from(sessionSlots).where(isNull(sessionSlots.projectId)).orderBy(asc(sessionSlots.idx)).get();
  const slot = free
    ? db.update(sessionSlots).set(fresh).where(eq(sessionSlots.id, free.id)).returning().get()
    : db.insert(sessionSlots).values({ idx: (listSlots(db).at(-1)?.idx ?? 0) + 1, ...fresh }).returning().get();
  logEvent(db, project.id, "session_claimed", { slot: slot.idx });
  return slot;
}

/** Drop the project's session row (project finished). The last session id stays in the event. */
export function releaseSlot(db: DbOrTx, projectId: string, reason: "done" | "owner"): void {
  const slot = slotOf(db, projectId);
  if (!slot) return;
  logEvent(db, projectId, "session_released", { slot: slot.idx, sessionId: slot.sessionId, runs: slot.runs, reason });
  db.delete(sessionSlots).where(eq(sessionSlots.id, slot.id)).run();
}

/** Start the project's next builder run in a fresh session. */
export function resetSession(db: DbOrTx, projectId: string, reason: "owner" | "too_large" | "resume_failed", info: Record<string, unknown> = {}): SessionSlot | undefined {
  const slot = slotOf(db, projectId);
  if (!slot) return undefined;
  logEvent(db, projectId, "session_rotated", { slot: slot.idx, previous: slot.sessionId, reason, ...info });
  return db
    .update(sessionSlots)
    .set({ sessionId: null, contextTokens: 0, rotations: slot.rotations + 1 })
    .where(eq(sessionSlots.id, slot.id))
    .returning()
    .get();
}

/** The session a builder run should continue, if the project holds a slot with a live session. */
export function projectSession(db: DbOrTx, projectId: string): string | undefined {
  return slotOf(db, projectId)?.sessionId ?? undefined;
}

/** Record a builder run in the project's slot; rotate when the session is too large or could not be resumed. */
export function afterBuilderRun(db: DbOrTx, projectId: string, outcome: Pick<ClaudeOutcome, "sessionId" | "contextTokens" | "errorKind" | "result" | "aborted">, resumedSlotSession: boolean, maxContext: number): void {
  const slot = slotOf(db, projectId);
  if (!slot) return;
  // A limit, auth problem or abort (pause, shutdown) cut the run short: the session itself is fine, keep its latest link.
  const interrupted = outcome.aborted || outcome.errorKind === "limit" || outcome.errorKind === "auth";
  if (resumedSlotSession && outcome.errorKind && !outcome.result && !interrupted) {
    // The session could not be continued (missing on disk, corrupted): start over next time.
    resetSession(db, projectId, "resume_failed", { errorKind: outcome.errorKind });
    return;
  }
  if (!outcome.sessionId) return;
  db.update(sessionSlots)
    .set({ sessionId: outcome.sessionId, contextTokens: outcome.contextTokens ?? 0, runs: slot.runs + 1, lastUsedAt: new Date() })
    .where(eq(sessionSlots.id, slot.id))
    .run();
  void maxContext; // rotation happens at the start of the next step (rotateIfTooLarge), never mid-step
}

/**
 * Called at the start of every planning/execution step: a session past the
 * limit is replaced before the step decides how to prompt, so a correction or
 * rework never lands in a fresh session without its context.
 */
export function rotateIfTooLarge(db: DbOrTx, projectId: string, maxContext: number): void {
  const slot = slotOf(db, projectId);
  if (slot?.sessionId && slot.contextTokens > maxContext) resetSession(db, projectId, "too_large", { contextTokens: slot.contextTokens });
}

/** How the owner opens the project's session in an interactive Claude Code terminal. */
export function resumeCommand(repoPath: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `cd ${q(repoPath)} && claude --resume ${sessionId}`;
}

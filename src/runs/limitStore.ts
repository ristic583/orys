import { eq } from "drizzle-orm";
import { INITIAL_LIMIT, type LimitSnapshot } from "../claude/limits.js";
import type { DbOrTx } from "../db/index.js";
import { limitState } from "../db/schema.js";

const ID = "global";

export function loadLimit(db: DbOrTx): LimitSnapshot {
  const row = db.select().from(limitState).where(eq(limitState.id, ID)).get();
  if (!row) return { ...INITIAL_LIMIT };
  return {
    status: row.status,
    rateLimitType: row.rateLimitType,
    utilization: row.utilization,
    resetAt: row.resetAt,
    detectedAt: row.detectedAt,
    sourceText: row.sourceText,
    authError: row.authError,
  };
}

export function saveLimit(db: DbOrTx, s: LimitSnapshot): void {
  db.insert(limitState)
    .values({ id: ID, ...s })
    .onConflictDoUpdate({ target: limitState.id, set: { ...s, updatedAt: new Date() } })
    .run();
}

export function lastProbeAt(db: DbOrTx): Date | null {
  return db.select({ at: limitState.lastProbeAt }).from(limitState).where(eq(limitState.id, ID)).get()?.at ?? null;
}

export function markProbe(db: DbOrTx, at: Date): void {
  saveLimit(db, loadLimit(db)); // make sure the row exists
  db.update(limitState).set({ lastProbeAt: at }).where(eq(limitState.id, ID)).run();
}

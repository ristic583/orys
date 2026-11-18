/**
 * Pure subscription-limit state logic (SPEC §6.3). The DB row in `limit_state`
 * is a persisted LimitSnapshot.
 */
import type { ErrorKind, LimitStatus } from "../core/types.js";
import type { RateLimitInfo } from "./schema.js";

export type LimitSnapshot = {
  status: LimitStatus;
  rateLimitType: string | null;
  utilization: number | null;
  resetAt: Date | null;
  detectedAt: Date | null;
  sourceText: string | null;
  authError: string | null;
};

export const INITIAL_LIMIT: LimitSnapshot = {
  status: "ok",
  rateLimitType: null,
  utilization: null,
  resetAt: null,
  detectedAt: null,
  sourceText: null,
  authError: null,
};

export type LimitObservation = {
  errorKind: ErrorKind | null;
  lastRateLimit?: RateLimitInfo;
  /** Result/stderr text, kept for the dashboard when something goes wrong. */
  text?: string;
  /** Whether the call reached the API (a result message was produced). */
  reachedApi: boolean;
};

const STATUS_FROM_EVENT: Record<string, LimitStatus> = {
  allowed: "ok",
  allowed_warning: "warning",
  rejected: "limited",
};

/** Fold one finished claude call into the limit state. */
export function applyObservation(
  prev: LimitSnapshot,
  obs: LimitObservation,
  now: Date,
  fallbackMinutes: number,
): LimitSnapshot {
  const next: LimitSnapshot = { ...prev };

  if (obs.errorKind === "auth") {
    next.authError = (obs.text ?? "authentication failed").slice(0, 500);
    return next;
  }
  if (obs.reachedApi && obs.errorKind !== "crash") next.authError = null;

  const ev = obs.lastRateLimit;
  if (ev) {
    next.status = STATUS_FROM_EVENT[ev.status] ?? prev.status;
    next.rateLimitType = ev.rateLimitType ?? null;
    // Utilization belongs to this event's window; the CLI only sends it near a
    // threshold, so an event without it means "no fresh number", not "unchanged".
    next.utilization = typeof ev.utilization === "number" ? ev.utilization : null;
    next.resetAt = typeof ev.resetsAt === "number" ? new Date(ev.resetsAt * 1000) : null;
    if (next.status === "limited") {
      next.detectedAt = now;
      next.sourceText = "rate_limit_event";
      if (!next.resetAt || next.resetAt <= now) next.resetAt = new Date(now.getTime() + fallbackMinutes * 60_000);
    }
    return next;
  }

  if (obs.errorKind === "limit") {
    return {
      ...next,
      status: "limited",
      resetAt: new Date(now.getTime() + fallbackMinutes * 60_000),
      detectedAt: now,
      sourceText: (obs.text ?? "").slice(0, 500),
    };
  }

  // A successful call without an event means we are clearly not blocked.
  if (obs.errorKind === null && prev.status === "limited") {
    next.status = "ok";
    next.resetAt = null;
  }
  return next;
}

/** True when the scheduler must not start any claude call. */
export function isBlocked(s: LimitSnapshot, now: Date): { blocked: boolean; reason?: string; until?: Date } {
  if (s.authError) return { blocked: true, reason: `auth: ${s.authError}` };
  if (s.status === "limited" && s.resetAt && s.resetAt > now) {
    return { blocked: true, reason: `limit (${s.rateLimitType ?? "unknown"})`, until: s.resetAt };
  }
  return { blocked: false };
}

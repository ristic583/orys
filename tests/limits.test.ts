import { describe, expect, it } from "vitest";
import { INITIAL_LIMIT, applyObservation, isBlocked } from "../src/claude/limits.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const at = (iso: string) => new Date(iso);
const secs = (iso: string) => Math.floor(at(iso).getTime() / 1000);

describe("limit state", () => {
  it("drops a stale utilization when the next event carries none", () => {
    const warned = applyObservation(
      INITIAL_LIMIT,
      { errorKind: null, reachedApi: true, lastRateLimit: { status: "allowed_warning", resetsAt: secs("2026-11-16T00:00:00Z"), rateLimitType: "seven_day", utilization: 0.98 } },
      NOW,
      30,
    );
    const s = applyObservation(warned, { errorKind: null, reachedApi: true, lastRateLimit: { status: "allowed", resetsAt: secs("2026-11-10T00:00:00Z"), rateLimitType: "five_hour" } }, NOW, 30);
    expect(s).toMatchObject({ status: "ok", utilization: null, rateLimitType: "five_hour" });
  });

  it("tracks utilization and warnings from rate_limit_event", () => {
    const s = applyObservation(
      INITIAL_LIMIT,
      { errorKind: null, reachedApi: true, lastRateLimit: { status: "allowed_warning", resetsAt: secs("2026-11-16T00:00:00Z"), rateLimitType: "seven_day", utilization: 0.36 } },
      NOW,
      30,
    );
    expect(s).toMatchObject({ status: "warning", utilization: 0.36, rateLimitType: "seven_day", resetAt: at("2026-11-16T00:00:00Z") });
    expect(isBlocked(s, NOW).blocked).toBe(false);
  });

  it("blocks until resetsAt on a rejected event, then unblocks by time", () => {
    const s = applyObservation(
      INITIAL_LIMIT,
      { errorKind: "limit", reachedApi: true, lastRateLimit: { status: "rejected", resetsAt: secs("2026-11-09T15:00:00Z"), rateLimitType: "five_hour" } },
      NOW,
      30,
    );
    expect(s.status).toBe("limited");
    expect(isBlocked(s, NOW)).toMatchObject({ blocked: true, until: at("2026-11-09T15:00:00Z") });
    expect(isBlocked(s, at("2026-11-09T15:00:01Z")).blocked).toBe(false);
  });

  it("falls back to now + N minutes when the limit is only recognised from text", () => {
    const s = applyObservation(INITIAL_LIMIT, { errorKind: "limit", reachedApi: true, text: "You've hit your limit" }, NOW, 30);
    expect(s.resetAt).toEqual(at("2026-11-09T12:30:00Z"));
    expect(s.sourceText).toContain("hit your limit");
  });

  it("uses the fallback when a rejected event has no usable reset time", () => {
    const s = applyObservation(INITIAL_LIMIT, { errorKind: "limit", reachedApi: true, lastRateLimit: { status: "rejected", resetsAt: null } }, NOW, 15);
    expect(s.resetAt).toEqual(at("2026-11-09T12:15:00Z"));
  });

  it("auth errors block regardless of limits and clear after a successful call", () => {
    const bad = applyObservation(INITIAL_LIMIT, { errorKind: "auth", reachedApi: true, text: "OAuth session expired" }, NOW, 30);
    expect(isBlocked(bad, NOW)).toMatchObject({ blocked: true, reason: expect.stringContaining("OAuth") });
    const good = applyObservation(bad, { errorKind: null, reachedApi: true }, NOW, 30);
    expect(good.authError).toBeNull();
  });

  it("a successful call without an event clears a stale limit", () => {
    const limited = { ...INITIAL_LIMIT, status: "limited" as const, resetAt: at("2026-11-09T11:00:00Z") };
    expect(applyObservation(limited, { errorKind: null, reachedApi: true }, NOW, 30).status).toBe("ok");
  });
});

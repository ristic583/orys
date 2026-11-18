/**
 * Project selection (SPEC §9): weighted fair share over a 7-day window,
 * deadline urgency, and a cache-locality bonus. Pure functions.
 */

export type Candidate = {
  id: string;
  slug: string;
  priority: number;
  deadline: Date | null;
  /** input + output + cache_creation tokens in the window. */
  tokens: number;
  /** When this project's last claude run ended. */
  lastRunAt: Date | null;
  createdAt: Date;
};

export type Scored = Candidate & {
  score: number;
  weight: number;
  urgency: number;
  share: number;
  locality: boolean;
};

const DAY = 864e5;
export const LOCALITY_WINDOW_MS = 50 * 60_000;
export const LOCALITY_BONUS = 1.5;
export const DEADLINE_SOON_MS = 48 * 3_600_000;
export const URGENCY_HORIZON_DAYS = 14;

export const weight = (priority: number) => 2 ** (priority - 1);

/** 1 without a deadline; grows linearly to 4 as the deadline comes within 14 days (and stays 4 past it). */
export function urgency(deadline: Date | null, now: Date): number {
  if (!deadline) return 1;
  const daysLeft = (deadline.getTime() - now.getTime()) / DAY;
  return 1 + 3 * Math.min(1, Math.max(0, 1 - daysLeft / URGENCY_HORIZON_DAYS));
}

/** Highest score first; ties go to higher priority, then the older project. */
export function rankCandidates(cands: Candidate[], now: Date): Scored[] {
  const total = cands.reduce((s, c) => s + c.tokens, 0);
  const deadlineSoon = (c: Candidate) => !!c.deadline && c.deadline.getTime() - now.getTime() <= DEADLINE_SOON_MS;
  return cands
    .map((c) => {
      const w = weight(c.priority);
      const u = urgency(c.deadline, now);
      const share = total > 0 ? c.tokens / total : 0;
      const warm = !!c.lastRunAt && now.getTime() - c.lastRunAt.getTime() < LOCALITY_WINDOW_MS;
      // Keep the warm cache, unless someone else has a deadline coming up.
      const locality = warm && !cands.some((o) => o.id !== c.id && deadlineSoon(o));
      const score = (w * u) / (1 + share) * (locality ? LOCALITY_BONUS : 1);
      return { ...c, score, weight: w, urgency: u, share, locality };
    })
    .sort((a, b) => b.score - a.score || b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
}

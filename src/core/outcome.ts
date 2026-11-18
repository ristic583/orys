/**
 * Level 2 (SPEC §22.5): what the owner is promised before building, how much
 * process the work gets, and what was delivered at the end. Pure schemas and
 * functions; no I/O.
 */
import { z } from "zod";
import type { Profile } from "./profiles.js";

export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];
export const VISIBLE_CHANGE = ["none", "little", "moderate", "large"] as const;
export type VisibleChange = (typeof VISIBLE_CHANGE)[number];

const short = (max: number) => z.string().trim().min(1).max(max);

// ─────────────────────────── outcome (before building) ───────────────────────────

export const OutcomeSchema = z
  .object({
    /** 2–5 plain sentences: what the owner can do or see afterwards. */
    summary_plain: z.string().trim().min(40).max(900),
    you_will_see: z.array(z.object({ where: short(80), what: short(240) })).max(12).default([]),
    stays_the_same: z.array(short(200)).max(8).default([]),
    visible_change: z.enum(VISIBLE_CHANGE),
    /** Steps before the owner can see it (deploy, migration, env). Empty = visible right after the merge. */
    to_see_it: z.array(short(200)).max(6).default([]),
    open_questions: z
      .array(z.object({ question: short(240), proposed_answer: short(240), why_it_matters: z.string().max(200).default("") }))
      .max(5)
      .default([]),
  })
  .refine((o) => o.you_will_see.length > 0 || o.visible_change === "none", {
    message: "you_will_see is empty, so visible_change must be \"none\" (or list what the owner will see)",
    path: ["you_will_see"],
  });
export type Outcome = z.infer<typeof OutcomeSchema>;

/** The plan's outcome as stored on the project, with the owner's answers to its open questions. */
export type StoredOutcome = Outcome & {
  /** question → answer; a missing question means the proposed answer is used. */
  answers?: Record<string, string>;
  /** Text the planner wrote before its JSON block. */
  overview?: string;
};

/** The answer that counts for each open question: the owner's, or the proposal. */
export function decidedAnswers(o: StoredOutcome | null | undefined): { question: string; answer: string; byOwner: boolean }[] {
  return (o?.open_questions ?? []).map((q) => {
    const own = o?.answers?.[q.question]?.trim();
    return { question: q.question, answer: own || q.proposed_answer, byOwner: !!own };
  });
}

// ─────────────────────────── scope → process ───────────────────────────

/** The planner's honest judgement of how big and risky the work is. */
export const ScopeSchema = z.object({
  size: z.enum(SIZES),
  risk: z.enum(RISKS),
  /** The work changes something people look at (screens, pages, layout). */
  ui: z.boolean(),
  /** How it should look is open (no layout given, "redesign", "make it modern"): show 2–3 directions first. */
  design_directions: z.boolean().default(false),
  reason: short(400),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const PROCESS_MODES = ["quick", "standard", "full"] as const;
export type ProcessMode = (typeof PROCESS_MODES)[number];

export type ProcessChoice = {
  mode: ProcessMode;
  scope: Scope;
  /** Master review after every task (else only per phase). */
  reviewPerTask: boolean;
  maxAttempts: number;
  /** Most phases the plan may have. */
  maxPhases: number;
  /** Whether the master reviewer checks the plan (quick: the owner's approval is enough). */
  planReview: boolean;
  /** Show 2–3 design directions for the owner to pick before building. */
  designDirections: boolean;
  /** One sentence for the owner. */
  why: string;
};

/**
 * How much process the work gets. Small and safe → quick (one phase, one
 * review at the end, no plan review); large or risky → full (review after
 * every task); the rest → standard. The project's profile still sets models.
 */
export function chooseProcess(scope: Scope, profile: Profile): ProcessChoice {
  const small = scope.size === "XS" || scope.size === "S";
  const big = scope.size === "L" || scope.size === "XL";
  const mode: ProcessMode = small && scope.risk === "low" ? "quick" : big || scope.risk === "high" ? "full" : "standard";
  const designDirections = scope.ui && scope.design_directions;
  const base = { scope, designDirections };
  if (mode === "quick") {
    return { ...base, mode, reviewPerTask: false, maxAttempts: Math.min(2, profile.maxAttempts), maxPhases: 1, planReview: false, why: `Small, low-risk job (${scope.size}): one phase, one review at the end.` };
  }
  if (mode === "full") {
    return { ...base, mode, reviewPerTask: true, maxAttempts: profile.maxAttempts, maxPhases: 8, planReview: true, why: `${big ? `Large job (${scope.size})` : "Risky change"}: every task is reviewed.` };
  }
  // Task reviews caught nothing in 13 of 13 runs (SPEC §22.7): only where the risk warrants them.
  const reviewPerTask = profile.reviewPerTask && scope.risk !== "low";
  return { ...base, mode, reviewPerTask, maxAttempts: profile.maxAttempts, maxPhases: 3, planReview: true, why: `Medium job (${scope.size}, ${scope.risk} risk): at most 3 phases, each reviewed${reviewPerTask ? ", and every task" : ""}.` };
}

/** The profile with the project's process applied (process wins for review and attempts). */
export function withProcess(profile: Profile, process: ProcessChoice | null | undefined): Profile {
  if (!process) return profile;
  return { ...profile, reviewPerTask: process.reviewPerTask, maxAttempts: process.maxAttempts };
}

// ─────────────────────────── estimate (§21, basic) ───────────────────────────

/** Minutes of agent work per task size: worker + gate + task review, ×1.2 for retries (LEVEL2 §4.3). */
export const MINUTES_BY_SIZE: Record<Size, number> = { XS: 4, S: 8, M: 15, L: 30, XL: 60 };

export type Estimate = {
  /** Agent work, minutes. */
  agentMinutes: number;
  /** When it is likely done if it starts now. */
  doneBy: Date;
  /** Expected pauses for the subscription limit. */
  limitPauses: number;
  /** Plain text, e.g. "about 40 min of agent work · done around 14:30". */
  text: string;
};

/**
 * Agent minutes from task sizes (calibrated per size from this machine's
 * history when available), plus one review per phase; calendar time adds
 * limit pauses when the quota is close.
 */
export function estimate(
  tasks: { size: Size | null }[],
  phases: number,
  opts: { now: Date; utilization?: number | null; minutesBySize?: Partial<Record<Size, number>>; designDirections?: boolean },
): Estimate {
  const per = { ...MINUTES_BY_SIZE, ...opts.minutesBySize };
  const work = tasks.reduce((m, t) => m + per[t.size ?? "S"], 0) + phases * 2 + (opts.designDirections ? 6 : 0);
  const agentMinutes = Math.max(5, Math.round(work));
  // A 5-hour window covers roughly 2–3 h of agent work with this mix of models (measured on earlier projects).
  const used = opts.utilization ?? 0;
  const windowMinutes = 150;
  const leftNow = Math.max(0, (1 - used) * windowMinutes);
  const limitPauses = agentMinutes <= leftNow ? 0 : Math.ceil((agentMinutes - leftNow) / windowMinutes);
  const calendar = agentMinutes + limitPauses * 120; // a pause lasts until the window resets: assume ~2 h
  const doneBy = new Date(opts.now.getTime() + calendar * 60_000);
  const work_ = agentMinutes < 90 ? `about ${roundTo(agentMinutes, 5)} min` : `about ${(agentMinutes / 60).toFixed(agentMinutes < 600 ? 1 : 0)} h`;
  const pauses = limitPauses ? ` · ${limitPauses === 1 ? "probably one pause" : `${limitPauses} pauses`} for the Claude limit` : "";
  return { agentMinutes, doneBy, limitPauses, text: `${work_} of agent work${pauses}` };
}

const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

// ─────────────────────────── sketch (SPEC §22.7) ───────────────────────────

const relFile = z.string().regex(/^[a-z0-9][a-z0-9._-]*\.png$/i, "a .png file name inside the version folder");

/** What a sketch run reports: something the owner can look at within minutes, and an honest note on what is fake. */
export const SketchSchema = z
  .object({
    summary_plain: z.string().trim().min(20).max(900),
    /** Screenshots inside the version folder, e.g. "home-1280.png". */
    screens: z.array(z.object({ file: relFile, caption: z.string().max(200).default("") })).max(12).default([]),
    /** For work without screens: a command and what it prints now. */
    demo: z.array(z.object({ command: short(300), output: z.string().max(2_000) })).max(6).default([]),
    what_is_real: z.array(short(240)).max(8).default([]),
    what_is_faked: z.array(short(240)).max(8).default([]),
    how_to_run: z.string().max(400).default(""),
    stack: z.array(z.string().max(80)).max(12).default([]),
    verify_commands: z.array(z.string().max(300)).max(8).default([]),
    scope: ScopeSchema,
    /**
     * Existing screens: what the owner sees today that this sketch leaves out
     * on purpose. The real build follows the sketch, so it disappears unless
     * the owner objects (first sketch-first run: four guest fields went
     * silently, because the sketch did not draw them).
     */
    no_longer_shown: z.array(short(240)).max(12).default([]),
    /** When the look is open: 2–3 directions, each with its own screenshots (and what it drops). */
    directions: z
      .array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), title: short(80), idea: short(400), screens: z.array(relFile).max(4).default([]), no_longer_shown: z.array(short(240)).max(12).default([]) }))
      .max(3)
      .default([]),
    /** The work has nothing to show before it is built (tests, refactor): skip the owner's look. */
    nothing_to_show: z.boolean().default(false),
  })
  .refine((s) => s.nothing_to_show || s.screens.length > 0 || s.demo.length > 0 || s.directions.some((d) => d.screens.length), {
    message: "show something: screenshots, directions with screenshots, or a demo (command and output); or set nothing_to_show",
  });
export type SketchOutput = z.infer<typeof SketchSchema>;

// ─────────────────────────── design directions ───────────────────────────

export const DesignSetSchema = z.object({
  directions: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), title: short(80), idea: short(400), file: z.string().regex(/^[a-z0-9-]+\.html$/) }))
    .min(2)
    .max(3),
});
export type DesignSet = z.infer<typeof DesignSetSchema>;
export type DesignChoice = { id: string; title: string; file: string; note: string };

// ─────────────────────────── handoff (at the end) ───────────────────────────

export const HandoffSchema = z.object({
  summary_plain: z.string().trim().min(20).max(1_200),
  /** Each promise from `you_will_see`, checked against what was built. */
  delivered: z.array(z.object({ promise: short(300), status: z.enum(["done", "partial", "missing"]), note: z.string().max(300).default("") })).max(16).default([]),
  /** How the owner sees it now (commands, URLs, deploy steps). */
  how_to_see: z.array(short(300)).max(8).default([]),
  known_gaps: z.array(short(300)).max(8).default([]),
});
export type Handoff = z.infer<typeof HandoffSchema> & { screenshots?: string[]; at?: string };

/** "Promise accuracy" (§22.1): share of promises delivered in full. */
export function promiseAccuracy(h: Handoff | null | undefined): number | null {
  if (!h?.delivered.length) return null;
  return h.delivered.filter((d) => d.status === "done").length / h.delivered.length;
}

// ─────────────────────────── warnings for the owner ───────────────────────────

export type OutcomeWarning = { code: "little_visible_change_with_ui" | "vague_goal"; text: string };

const VAGUE = /^(make it |more |)(modern|better|nice|nicer|clean|cleaner|pretty|prettier|beautiful|good|improve[ds]?|redesign)( design| look| ui)?\.?$/i;

/** Things the owner must notice before approving. `hasUi`: the project has screens at all. */
export function outcomeWarnings(o: Outcome, opts: { hasUi: boolean; goals?: string[] }): OutcomeWarning[] {
  const w: OutcomeWarning[] = [];
  if (opts.hasUi && (o.visible_change === "none" || o.visible_change === "little")) {
    w.push({ code: "little_visible_change_with_ui", text: "You will see little or nothing new on screen: most of this work is under the hood." });
  }
  const vague = (opts.goals ?? []).filter((g) => g.trim().split(/\s+/).length < 4 && VAGUE.test(g.trim()));
  if (vague.length) w.push({ code: "vague_goal", text: `"${vague[0]}" can mean many things. Check the answers to the open questions, or say what exactly you want to see.` });
  return w;
}

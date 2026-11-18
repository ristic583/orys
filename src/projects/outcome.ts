/**
 * The owner's side of level 2 (SPEC §22.5): what they are promised before
 * building (outcome card, estimate, design directions), their answers and
 * choice, and the verdict on the handoff (accept / send back).
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { decidedAnswers, estimate, outcomeWarnings, promiseAccuracy, SIZES, type Size } from "../core/outcome.js";
import type { Db, DbOrTx } from "../db/index.js";
import { events, phases, projects, runs, sketches, tasks, verifications, type Project } from "../db/schema.js";
import { profileOf, roleOf } from "../loops/common.js";
import { designsDir, readDesigns } from "../loops/design.js";
import { agreedSketch, concludeSketch, latestSketch, listSketches, noLongerShown, normalizeSketch, sketchDir, sketchScreens } from "../loops/sketch.js";
import type { LoopDeps } from "../loops/common.js";
import { loadLimit } from "../runs/limitStore.js";
import { applyProjectEvent, getProject, logEvent, phaseBranch } from "./repo.js";
import { slugify } from "../loops/plan.js";

export class OwnerActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerActionRefused";
  }
}

/** Whether the project has screens at all (for the "little visible change" warning). */
function hasUi(p: Project): boolean {
  if (p.process?.scope.ui) return true;
  return ["web", "frontend", "client", "index.html", "src/App.tsx", "src/app"].some((f) => existsSync(join(p.repoPath, f)));
}

/**
 * Minutes of agent work per task size measured on this machine (median of
 * finished tasks: their runs plus gate time), where there are at least 3.
 */
export function measuredMinutesBySize(db: DbOrTx): Partial<Record<Size, number>> {
  const done = db.select({ id: tasks.id, size: tasks.size }).from(tasks).where(and(eq(tasks.status, "done"), isNotNull(tasks.size))).all();
  if (!done.length) return {};
  const ids = done.map((t) => t.id);
  const runRows = db.select({ taskId: runs.taskId, startedAt: runs.startedAt, endedAt: runs.endedAt }).from(runs).where(inArray(runs.taskId, ids)).all();
  const verRows = db.select({ taskId: verifications.taskId, ms: verifications.durationMs }).from(verifications).where(inArray(verifications.taskId, ids)).all();
  const out: Partial<Record<Size, number>> = {};
  for (const size of SIZES) {
    const mins = done
      .filter((t) => t.size === size)
      .map((t) => {
        const ms = runRows.filter((r) => r.taskId === t.id && r.endedAt).reduce((a, r) => a + (r.endedAt!.getTime() - r.startedAt.getTime()), 0) + verRows.filter((v) => v.taskId === t.id).reduce((a, v) => a + v.ms, 0);
        return ms / 60_000;
      })
      .sort((a, b) => a - b);
    if (mins.length >= 3) out[size] = mins[Math.floor(mins.length / 2)]!;
  }
  return out;
}

/** Everything the outcome card needs. Null outcome = a project planned before level 2. */
export function outcomeView(db: DbOrTx, idOrSlug: string, now = new Date()) {
  const p = getProject(db, idOrSlug);
  const ph = db.select().from(phases).where(eq(phases.projectId, p.id)).orderBy(asc(phases.idx)).all();
  const ts = ph.length ? db.select({ size: tasks.size, status: tasks.status, phaseId: tasks.phaseId }).from(tasks).where(inArray(tasks.phaseId, ph.map((x) => x.id))).all() : [];
  const open = ts.filter((t) => t.status !== "done" && t.status !== "skipped");
  const limit = loadLimit(db);
  const est = ph.length
    ? estimate(open, ph.filter((x) => x.status !== "done").length, { now, utilization: limit.utilization, minutesBySize: measuredMinutesBySize(db), designDirections: !!p.process?.designDirections && !p.designChoice && !readDesigns(p) })
    : null;
  const goals = [...(p.modeDetails.rework?.successCriteria ?? []), ...p.aspects];
  return {
    outcome: p.outcome ?? null,
    answers: decidedAnswers(p.outcome),
    process: p.process ?? null,
    // A sketch the owner agreed on makes a vague goal concrete: no "Modern design can mean many things" then.
    warnings: p.outcome ? outcomeWarnings(p.outcome, { hasUi: hasUi(p), goals: agreedSketch(db, p.id) ? [] : goals }) : [],
    estimate: est && { ...est, doneBy: est.doneBy.toISOString() },
    phases: ph.map((x) => ({ idx: x.idx, title: x.title, goalPlain: x.goalPlain, visible: x.visible, status: x.status })),
    designs: designsWithPreviews(p),
    sketch: (() => {
      const s = agreedSketch(db, p.id);
      return s && s.status === "approved" ? { version: s.version, dir: sketchDir(s.version), direction: s.direction, screens: sketchScreens(s), noLongerShown: p.mode === "scratch" || !s.summary.no_longer_shown ? null : noLongerShown(s) } : null;
    })(),
    designChoice: p.designChoice ?? null,
    handoff: p.handoff ?? null,
    accepted: p.accepted ?? null,
    returns: p.returns,
    promiseAccuracy: promiseAccuracy(p.handoff),
  };
}

/** Directions with the screenshot the designer took of each (for thumbnails), when there is one. */
function designsWithPreviews(p: Project) {
  const set = readDesigns(p);
  if (!set) return null;
  const dir = join(p.repoPath, designsDir(p));
  const png = (id: string, w: number) => (existsSync(join(dir, `${id}-${w}.png`)) ? `${id}-${w}.png` : null);
  return { directions: set.directions.map((d) => ({ ...d, preview: png(d.id, 1280), previewPhone: png(d.id, 375) })) };
}

// ─────────────────────────── sketch (SPEC §22.7) ───────────────────────────

/** All versions of the project's sketch, newest last, with what the owner can do now. */
export function sketchView(db: DbOrTx, idOrSlug: string) {
  const p = getProject(db, idOrSlug);
  const versions = listSketches(db, p.id).map((s) => ({
    version: s.version,
    status: s.status,
    feedback: s.feedback,
    direction: s.direction,
    createdAt: s.createdAt,
    dir: sketchDir(s.version),
    ...normalizeSketch(s.summary),
    // Absent (not empty) on sketches made before the list existed: unknown, so the page says nothing.
    no_longer_shown: s.summary.no_longer_shown as string[] | undefined,
  }));
  return { versions, waiting: p.status === "awaiting_owner" && p.ownerGate === "approve_sketch", sketching: p.status === "sketching" };
}

export const SketchReviseSchema = z.object({ message: z.string().trim().min(3).max(4_000), different: z.boolean().default(false), direction: z.string().optional() });

/** The owner reacts: another version, with their note (and, optionally, "try a clearly different direction"). */
export function reviseSketch(db: Db, idOrSlug: string, input: z.input<typeof SketchReviseSchema>): Project {
  const { message, different, direction } = SketchReviseSchema.parse(input);
  return db.transaction((tx) => {
    const p = getProject(tx, idOrSlug);
    const s = latestSketch(tx, p.id);
    if (p.status !== "awaiting_owner" || p.ownerGate !== "approve_sketch" || s?.status !== "ready") throw new OwnerActionRefused("there is no sketch waiting for your reaction");
    if (direction && !s.summary.directions.some((d) => d.id === direction)) throw new OwnerActionRefused(`no direction "${direction}" in this sketch`);
    const note = different ? `Try a clearly different direction (layout and concept, not only colours). ${message}` : message;
    tx.update(sketches).set({ status: "revise", feedback: note, direction: direction ?? null }).where(eq(sketches.id, s.id)).run();
    logEvent(tx, p.id, "sketch_revised", { version: s.version, different, direction: direction ?? null, note: note.slice(0, 500) });
    return applyProjectEvent(tx, p, { type: "sketch_revise" });
  });
}

export const SketchApproveSchema = z.object({ direction: z.string().optional() });

/** "That's it, build it properly": the latest version becomes the spec; on to the plan (or the full map/architecture for big work). */
export async function approveSketch(deps: Pick<LoopDeps, "db" | "runner" | "config">, idOrSlug: string, input: z.input<typeof SketchApproveSchema> = {}): Promise<Project> {
  const { direction } = SketchApproveSchema.parse(input);
  const { db } = deps;
  const p = getProject(db, idOrSlug);
  const s = latestSketch(db, p.id);
  if (p.status !== "awaiting_owner" || p.ownerGate !== "approve_sketch" || s?.status !== "ready") throw new OwnerActionRefused("there is no sketch waiting for your approval");
  if (s.summary.directions.length && !direction) throw new OwnerActionRefused("pick one of the directions first");
  if (direction && !s.summary.directions.some((d) => d.id === direction)) throw new OwnerActionRefused(`no direction "${direction}" in this sketch`);
  const row = db.update(sketches).set({ status: "approved", direction: direction ?? null }).where(eq(sketches.id, s.id)).returning().get();
  logEvent(db, p.id, "sketch_approved", { version: s.version, direction: direction ?? null, size: s.summary.scope.size });
  await concludeSketch(deps as LoopDeps, p, row);
  return getProject(db, p.id);
}

export const AnswersSchema = z.object({ answers: z.record(z.string(), z.string().max(500)) });

/** The owner answers (or overrides the proposed answers to) the plan's open questions. */
export function setAnswers(db: Db, idOrSlug: string, answers: Record<string, string>): Project {
  const p = getProject(db, idOrSlug);
  if (!p.outcome) throw new OwnerActionRefused("this project has no outcome to answer");
  if (p.status !== "awaiting_owner") throw new OwnerActionRefused("answers can be changed only before the plan is approved");
  const known = new Set(p.outcome.open_questions.map((q) => q.question));
  const unknown = Object.keys(answers).filter((q) => !known.has(q));
  if (unknown.length) throw new OwnerActionRefused(`unknown question: ${unknown[0]}`);
  const merged = { ...p.outcome.answers, ...Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a.trim()])) };
  logEvent(db, p.id, "owner_answered", { count: Object.keys(answers).length });
  return db.update(projects).set({ outcome: { ...p.outcome, answers: merged } }).where(eq(projects.id, p.id)).returning().get();
}

export const DesignChoiceSchema = z.object({ id: z.string().min(1), note: z.string().max(1_000).default("") });

/** The owner picks one of the design directions (before approving the plan). */
export function chooseDesign(db: Db, idOrSlug: string, input: z.input<typeof DesignChoiceSchema>): Project {
  const { id, note } = DesignChoiceSchema.parse(input);
  const p = getProject(db, idOrSlug);
  const set = readDesigns(p);
  const d = set?.directions.find((x) => x.id === id);
  if (!d) throw new OwnerActionRefused(`no design direction "${id}"`);
  if (p.status !== "awaiting_owner") throw new OwnerActionRefused("the design can be chosen only before the plan is approved");
  logEvent(db, p.id, "design_chosen", { id, note: note.slice(0, 300) });
  return db.update(projects).set({ designChoice: { id: d.id, title: d.title, file: d.file, note: note.trim() } }).where(eq(projects.id, p.id)).returning().get();
}

/** Refuse plan approval while design directions wait for a pick. */
export function assertReadyToApprove(p: Project): void {
  if (readDesigns(p) && !p.designChoice) throw new OwnerActionRefused("pick a design direction first: the workers build the one you choose");
}

/** The owner accepts the handoff. */
export function acceptHandoff(db: Db, idOrSlug: string): Project {
  const p = getProject(db, idOrSlug);
  if (p.status !== "done" || !p.handoff) throw new OwnerActionRefused("there is no finished result to accept yet");
  logEvent(db, p.id, "handoff_accepted", { returns: p.returns, firstTime: p.returns === 0, promiseAccuracy: promiseAccuracy(p.handoff) });
  return db.update(projects).set({ accepted: true }).where(eq(projects.id, p.id)).returning().get();
}

/**
 * The owner sends the result back with a note: a new phase with one task that
 * addresses it, and the project runs again. The next handoff is checked
 * against the same promises plus the note.
 */
export function returnHandoff(db: Db, idOrSlug: string, note: string): Project {
  const text = note.trim();
  if (text.length < 5) throw new OwnerActionRefused("say what is wrong or missing, so the agents can fix it");
  return db.transaction((tx) => {
    const p = getProject(tx, idOrSlug);
    if (p.status !== "done" || !p.handoff) throw new OwnerActionRefused("there is no finished result to send back");
    const all = tx.select().from(phases).where(eq(phases.projectId, p.id)).orderBy(asc(phases.idx)).all();
    const last = all.at(-1);
    const gate = last ? [...new Set([...tx.select({ v: tasks.verifyCommands }).from(tasks).where(eq(tasks.phaseId, last.id)).all().flatMap((t) => t.v), ...last.verifyCommands])] : [];
    const idx = (last?.idx ?? 0) + 1;
    const round = p.returns + 1;
    const title = `Owner feedback${round > 1 ? ` (round ${round})` : ""}`;
    const phase = tx
      .insert(phases)
      .values({ projectId: p.id, idx, title, goal: "Address the owner's feedback on the delivered result", goalPlain: "What you sent back is fixed", visible: true, status: "active", branch: phaseBranch(p, idx, slugify(title)) })
      .returning()
      .get();
    const worker = roleOf(p, "worker");
    tx.insert(tasks)
      .values({
        phaseId: phase.id,
        idx: 1,
        key: `p${idx}-feedback`,
        title: "Fix what the owner sent back",
        spec: [
          "The owner looked at the finished result and sent it back:",
          "",
          `> ${text.replace(/\n/g, "\n> ")}`,
          "",
          "What was handed over:",
          p.handoff.summary_plain,
          "",
          "Fix exactly what the owner asks for; keep everything else as it is. If it is about what the owner sees, take screenshots before and after.",
        ].join("\n"),
        acceptance: ["Every point of the owner's note is addressed", "All verify commands pass"],
        verifyCommands: gate.length ? gate : ["true"],
        model: worker.model,
        effort: worker.effort,
        maxAttempts: profileOf(p).maxAttempts,
        size: "S",
        status: "ready",
      })
      .run();
    logEvent(tx, p.id, "handoff_returned", { round, note: text.slice(0, 1_000) });
    tx.update(projects).set({ accepted: false, returns: round, handoff: null }).where(eq(projects.id, p.id)).run();
    return applyProjectEvent(tx, getProject(tx, p.id), { type: "reopen" });
  });
}

/** Level-2 metrics (SPEC §22.1) over all handed-over projects. */
export function ownerMetrics(db: DbOrTx) {
  const ps = db.select().from(projects).all();
  const handedOver = ps.filter((p) => p.accepted !== null || p.handoff);
  const judged = ps.filter((p) => p.accepted === true || p.returns > 0);
  const acceptedFirst = ps.filter((p) => p.accepted === true && p.returns === 0).length;
  const accuracies = ps.map((p) => promiseAccuracy(p.handoff)).filter((x): x is number => x !== null);
  const decisions = db.select({ id: events.id }).from(events).where(inArray(events.type, OWNER_EVENTS)).all().length;
  // SPEC §22.7 target: the first sketch within 10 minutes of the start.
  const firstSketch = ps
    .map((p) => {
      const ready = db.select({ at: events.createdAt, payload: events.payload }).from(events).where(and(eq(events.projectId, p.id), eq(events.type, "sketch_ready"))).orderBy(asc(events.id)).get();
      const started = db.select({ at: events.createdAt }).from(events).where(and(eq(events.projectId, p.id), eq(events.type, "project_status"))).orderBy(asc(events.id)).get();
      return ready && started ? (ready.at.getTime() - started.at.getTime()) / 60_000 : null;
    })
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  return {
    handedOver: handedOver.length,
    judged: judged.length,
    acceptedFirstTime: acceptedFirst,
    acceptedFirstTimeRate: judged.length ? acceptedFirst / judged.length : null,
    promiseAccuracy: accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null,
    ownerDecisions: decisions,
    ownerDecisionsPerProject: ps.length ? decisions / ps.length : null,
    /** Median minutes from the start to the first sketch. */
    firstSketchMinutes: firstSketch.length ? firstSketch[Math.floor(firstSketch.length / 2)]! : null,
  };
}

/** Events that are an owner decision (counted as the owner's effort). */
export const OWNER_EVENTS = ["sketch_revised", "sketch_approved", "plan_approved_by_owner", "owner_answered", "design_chosen", "handoff_accepted", "handoff_returned", "owner_choice", "owner_answer"];

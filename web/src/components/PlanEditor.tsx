/**
 * Plan editor (SPEC §17.3, M10): edit, add, move and delete tasks and phases on the plan
 * diagram. Every edit goes to the API, which validates the whole plan and returns it;
 * a 422 carries problems that point at a task, phase or field, highlighted in place.
 */
import { useOutcome } from "./Outcome";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState, type ReactNode } from "react";
import { api, ApiError, EFFORTS, MODELS, type Effort, type ModelName, type NewTask, type Phase, type PlanProblem, type ProjectDetail, type Task, type TaskEdit, type TaskReview } from "../api";
import { ErrorText, Segmented } from "../ui";
import { Icon } from "./Icon";

// ─────────── shared edit state ───────────

type EditCtx = {
  projectId: string;
  phases: Phase[];
  run: (op: () => Promise<Phase[]>, after?: () => void) => void;
  pending: boolean;
  error: unknown;
  problems: PlanProblem[];
  clear: () => void;
};
const Ctx = createContext<EditCtx | null>(null);
export const usePlanEdit = () => useContext(Ctx);

export function PlanEditProvider({ projectId, phases, children }: { projectId: string; phases: Phase[]; children: ReactNode }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (op: () => Promise<Phase[]>) => op(),
    onSuccess: (next) => {
      qc.setQueryData(["phases", projectId], next);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
  const problems = m.error instanceof ApiError ? m.error.planProblems : [];
  const value: EditCtx = {
    projectId,
    phases,
    run: (op, after) => m.mutate(op, { onSuccess: () => after?.() }),
    pending: m.isPending,
    error: m.error,
    problems,
    clear: () => m.reset(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const LOCK_TEXT: Record<string, string> = {
  running: "A worker is on it right now.",
  in_review: "It is being reviewed.",
  in_progress: "It has started; edit it after it finishes or fails.",
  done: "It is done.",
  skipped: "It was skipped.",
  phase_started: "The phase has started.",
  phase_done: "The phase is done.",
};
export const lockText = (reason: string | null | undefined) => (reason ? LOCK_TEXT[reason] ?? reason : null);

/** Problems for one task or phase (field problems included). */
export const problemsFor = (problems: PlanProblem[], q: { taskKey?: string; phaseIdx?: number }) =>
  problems.filter((p) => (q.taskKey != null && p.taskKey === q.taskKey) || (q.phaseIdx != null && p.phaseIdx === q.phaseIdx && p.taskKey == null));

// ─────────── problems banner ───────────

export function ProblemsBanner() {
  const e = usePlanEdit();
  if (!e?.error) return null;
  const err = e.error;
  const list = e.problems;
  return (
    <div className="callout bad plan-problems" role="alert">
      <div className="plan-problems-head">
        <strong>{err instanceof ApiError && err.status === 409 ? "Can't change the plan right now" : "That change would break the plan"}</strong>
        <button className="ghost sm push" onClick={e.clear}>Dismiss</button>
      </div>
      {list.length ? (
        <ul>
          {list.map((p, i) => (
            <li key={i}>
              {p.taskKey && <span className="mono node-key">{p.taskKey}</span>} {p.phaseIdx != null && !p.taskKey && <span className="muted">Phase {p.phaseIdx}: </span>}
              {p.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{err instanceof Error ? err.message : String(err)}</p>
      )}
    </div>
  );
}

// ─────────── approve plan ───────────

export function ApproveBar({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const approve = useMutation({ mutationFn: () => api.approvePlan(project.id), onSuccess: () => void qc.invalidateQueries() });
  const outcome = useOutcome(project.id).data;
  if (project.status !== "awaiting_owner" || project.ownerGate !== "approve_plan") return null;
  const needsDesign = !!outcome?.designs && !outcome.designChoice;
  return (
    <div className="card approve-bar">
      <div>
        <h2>The plan is ready for you</h2>
        <p className="muted">
          {needsDesign
            ? "Pick a design direction above first: the workers build the one you choose."
            : outcome?.process?.planReview === false
              ? "A small job, so no extra plan review: check what you will get above, then start. Nothing is built before you do."
              : "The reviewer approved it. Check what you will get above, change anything below, then start: nothing is built before you do."}
        </p>
        <ErrorText error={approve.error} />
      </div>
      <button className="primary" disabled={approve.isPending || needsDesign} onClick={() => approve.mutate()}>
        <Icon name="play" size={16} /> Start building
      </button>
    </div>
  );
}

// ─────────── task form (edit + new) ───────────

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const REVIEW_OPTS: { id: TaskReview; label: string }[] = [
  { id: "default", label: "Profile default" },
  { id: "always", label: "Always review" },
  { id: "never", label: "Gate only" },
];

type FormState = { title: string; spec: string; acceptance: string; verify: string; deps: string[]; model: ModelName | ""; effort: Effort; review: TaskReview };

function initial(t: Task | null): FormState {
  return {
    title: t?.title ?? "",
    spec: t?.spec ?? "",
    acceptance: (t?.acceptance ?? []).join("\n"),
    verify: (t?.verifyCommands ?? []).join("\n"),
    deps: t?.dependsOnKeys ?? [],
    model: t?.modelSource === "owner" && t.model ? (t.model as ModelName) : "",
    effort: ((t?.effort as Effort | null) ?? "medium") as Effort,
    review: t?.review ?? "default",
  };
}

/**
 * Edits `task`, or creates a new task in `phase` when `task` is null.
 * Dependencies are offered from the same phase and earlier phases only (the validator's rule).
 */
export function TaskForm({ task, phase, onDone }: { task: Task | null; phase: Phase; onDone: () => void }) {
  const e = usePlanEdit()!;
  const [f, setF] = useState<FormState>(() => initial(task));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const all = e.phases.flatMap((p) => p.tasks.map((t) => ({ t, p })));
  const idOf = new Map(all.map(({ t }) => [t.key, t.id]));
  const candidates = e.phases.filter((p) => p.idx <= phase.idx).map((p) => ({ p, tasks: p.tasks.filter((t) => t.id !== task?.id) })).filter((g) => g.tasks.length);
  const fieldProblems = task ? e.problems.filter((p) => p.taskKey === task.key && p.field) : e.problems.filter((p) => !p.taskKey && p.field);
  const bad = (field: string) => fieldProblems.filter((p) => p.field === field);

  const submit = () => {
    const before = initial(task);
    const body: TaskEdit = {};
    if (!task || f.title !== before.title) body.title = f.title.trim();
    if (!task || f.spec !== before.spec) body.spec = f.spec.trim();
    if (!task || f.acceptance !== before.acceptance) body.acceptance = lines(f.acceptance);
    if (!task || f.verify !== before.verify) body.verifyCommands = lines(f.verify);
    if (!task || f.deps.join() !== before.deps.join()) body.dependsOn = f.deps.map((k) => idOf.get(k)!).filter(Boolean);
    if (!task || f.model !== before.model) body.model = f.model || null;
    if (!task || f.effort !== before.effort) body.effort = f.effort;
    if (!task || f.review !== before.review) body.review = f.review;
    if (task && Object.keys(body).length === 0) return onDone();
    e.run(() => (task ? api.editTask(task.id, body) : api.addTask(phase.id, body as NewTask)), onDone);
  };

  return (
    <form className="task-form" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
      <Field label="Title" problems={bad("title")}>
        <input value={f.title} onChange={(x) => set("title", x.target.value)} required aria-invalid={bad("title").length > 0} />
      </Field>
      <Field label="What to do" problems={bad("spec")}>
        <textarea rows={5} value={f.spec} onChange={(x) => set("spec", x.target.value)} required aria-invalid={bad("spec").length > 0} />
      </Field>
      <Field label="Done when (one per line)" problems={bad("acceptance")}>
        <textarea rows={3} value={f.acceptance} onChange={(x) => set("acceptance", x.target.value)} required aria-invalid={bad("acceptance").length > 0} />
      </Field>
      <Field label="Checks that must pass (one command per line)" problems={bad("verifyCommands")}>
        <textarea className="mono" rows={3} value={f.verify} onChange={(x) => set("verify", x.target.value)} required aria-invalid={bad("verifyCommands").length > 0} />
      </Field>
      <Field label="Starts after" problems={bad("dependsOn")}>
        {candidates.length === 0 ? (
          <p className="muted small">No earlier tasks to depend on.</p>
        ) : (
          <div className="dep-groups">
            {candidates.map(({ p, tasks }) => (
              <div key={p.id} className="dep-group">
                <span className="muted small">Phase {p.idx}</span>
                <div className="ideas">
                  {tasks.map((t) => {
                    const on = f.deps.includes(t.key);
                    return (
                      <button type="button" key={t.id} className={`dep-chip${on ? " on" : ""}`} aria-pressed={on} title={t.title}
                        onClick={() => set("deps", on ? f.deps.filter((k) => k !== t.key) : [...f.deps, t.key])}>
                        <span className="mono">{t.key}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Field>
      <div className="row three">
        <label>
          Model
          <select value={f.model} onChange={(x) => set("model", x.target.value as ModelName | "")}>
            <option value="">Planner's choice{task?.modelSource !== "owner" && task?.model ? ` (${task.model})` : ""}</option>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>
          Effort
          <select value={f.effort} onChange={(x) => set("effort", x.target.value as Effort)}>
            {EFFORTS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>
          Review
          <Segmented label="Review" value={f.review} onChange={(v) => set("review", v)} options={REVIEW_OPTS} />
        </label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={e.pending}>{task ? "Save changes" : "Add task"}</button>
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function Field({ label, problems, children }: { label: string; problems: PlanProblem[]; children: ReactNode }) {
  return (
    <div className={`field${problems.length ? " has-problem" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {problems.map((p, i) => <span key={i} className="field-problem">{p.message}</span>)}
    </div>
  );
}

// ─────────── move / delete a task ───────────

export function TaskMoveDelete({ task, onDeleted }: { task: Task; onDeleted: () => void }) {
  const e = usePlanEdit()!;
  const targets = e.phases.filter((p) => p.canAddTasks);
  const here = e.phases.find((p) => p.tasks.some((t) => t.id === task.id))!;
  const [to, setTo] = useState(here.id);
  const target = e.phases.find((p) => p.id === to) ?? here;
  const max = target.tasks.filter((t) => t.id !== task.id).length;
  const [pos, setPos] = useState(Math.max(0, here.tasks.findIndex((t) => t.id === task.id)));
  return (
    <div className="move-row">
      <label className="inline">
        Move to
        <select value={to} onChange={(x) => { setTo(x.target.value); setPos(0); }}>
          {targets.map((p) => <option key={p.id} value={p.id}>Phase {p.idx}: {p.title}</option>)}
        </select>
      </label>
      <label className="inline">
        position
        <select value={Math.min(pos, max)} onChange={(x) => setPos(Number(x.target.value))}>
          {Array.from({ length: max + 1 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
        </select>
      </label>
      <button className="ghost sm" disabled={e.pending} onClick={() => e.run(() => api.moveTask(task.id, to, Math.min(pos, max)))}>Move</button>
      <button className="ghost sm danger push" disabled={e.pending}
        onClick={() => confirm(`Delete ${task.key}? Tasks that depend on it must be changed first.`) && e.run(() => api.deleteTask(task.id), onDeleted)}>
        Delete task
      </button>
    </div>
  );
}

// ─────────── phase actions ───────────

export function PhaseActions({ phase, onAddTask }: { phase: Phase; onAddTask: () => void }) {
  const e = usePlanEdit();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(phase.title);
  const [goal, setGoal] = useState(phase.goal);
  if (!e) return null;
  const lock = lockText(phase.lockedReason);
  if (editing)
    return (
      <form className="phase-edit" onSubmit={(ev) => { ev.preventDefault(); e.run(() => api.editPhase(phase.id, { title: title.trim(), goal: goal.trim() }), () => setEditing(false)); }}>
        <input value={title} onChange={(x) => setTitle(x.target.value)} aria-label="Phase title" required />
        <textarea rows={2} value={goal} onChange={(x) => setGoal(x.target.value)} aria-label="Phase goal" />
        <div className="form-actions">
          <button className="primary sm" type="submit" disabled={e.pending}>Save</button>
          <button className="ghost sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    );
  return (
    <div className="phase-actions">
      {phase.canAddTasks && <button className="ghost sm" onClick={onAddTask}><Icon name="plus" size={14} />Add task</button>}
      {phase.editable && <button className="ghost sm" onClick={() => setEditing(true)}>Rename</button>}
      {phase.deletable && (
        <button className="ghost sm danger" disabled={e.pending}
          onClick={() => confirm(`Delete phase ${phase.idx} "${phase.title}" and its ${phase.tasks.length} task(s)?`) && e.run(() => api.deletePhase(phase.id))}>
          Delete phase
        </button>
      )}
      {!phase.canAddTasks && phase.lockedReason === "phase_started" && lock && <span className="lock-note"><Icon name="lock" size={13} />{lock}</span>}
    </div>
  );
}

// ─────────── add a phase ───────────

export function AddPhase() {
  const e = usePlanEdit();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [task, setTask] = useState({ title: "", spec: "", acceptance: "", verify: "" });
  if (!e) return null;
  if (!open)
    return (
      <button className="add-phase" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> Add phase
      </button>
    );
  return (
    <form className="card add-phase-form" onSubmit={(ev) => {
      ev.preventDefault();
      e.run(() => api.addPhase(e.projectId, {
        title: title.trim(), goal: goal.trim(),
        firstTask: { title: task.title.trim(), spec: task.spec.trim(), acceptance: lines(task.acceptance), verifyCommands: lines(task.verify) },
      }), () => setOpen(false));
    }}>
      <h2>New phase</h2>
      <div className="row">
        <label>Title<input value={title} onChange={(x) => setTitle(x.target.value)} required /></label>
        <label>Goal<input value={goal} onChange={(x) => setGoal(x.target.value)} required /></label>
      </div>
      <p className="muted small">A phase starts with at least one task.</p>
      <div className="row">
        <label>First task<input value={task.title} onChange={(x) => setTask({ ...task, title: x.target.value })} required /></label>
        <label>Checks (one per line)<textarea className="mono" rows={2} value={task.verify} onChange={(x) => setTask({ ...task, verify: x.target.value })} required /></label>
      </div>
      <div className="row">
        <label>What to do<textarea rows={3} value={task.spec} onChange={(x) => setTask({ ...task, spec: x.target.value })} required /></label>
        <label>Done when (one per line)<textarea rows={3} value={task.acceptance} onChange={(x) => setTask({ ...task, acceptance: x.target.value })} required /></label>
      </div>
      <div className="form-actions">
        <button className="primary" type="submit" disabled={e.pending}>Add phase</button>
        <button className="ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

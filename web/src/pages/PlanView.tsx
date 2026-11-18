/**
 * The plan as a diagram: every phase is a lane with its tasks as a dependency graph
 * (columns by depth, curved edges), lanes joined by merges; details in a side drawer.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmtTokens, type Phase, type ProjectDetail, type Task } from "../api";
import { Icon } from "../components/Icon";
import { OutcomeCard } from "../components/Outcome";
import { AddPhase, ApproveBar, lockText, PhaseActions, PlanEditProvider, ProblemsBanner, problemsFor, TaskForm, TaskMoveDelete, usePlanEdit } from "../components/PlanEditor";
import { TaskDetail } from "../components/TaskParts";
import { Badge, ErrorText, Expandable, toneOf } from "../ui";

const isDone = (s: string) => s === "done" || s === "skipped";
const RUNNING = ["running", "verifying", "reviewing"];

function phaseState(ph: Phase): "done" | "active" | "blocked" | "pending" {
  if (ph.status === "done") return "done";
  if (ph.status === "blocked") return "blocked";
  if (ph.status === "pending") return "pending";
  return "active";
}

export function PlanView({ phases, project }: { phases: Phase[]; project: ProjectDetail }) {
  // The editor turns on once the API reports what can be edited (M10); older servers get the read-only plan.
  const editing = phases.some((p) => p.editable !== undefined);
  const body = <Plan phases={phases} project={project} />;
  return editing ? <PlanEditProvider projectId={project.id} phases={phases}>{body}</PlanEditProvider> : body;
}

function Plan({ phases, project }: { phases: Phase[]; project: ProjectDetail }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [newIn, setNewIn] = useState<string | null>(null);
  const allTasks = useMemo(() => phases.flatMap((p) => p.tasks), [phases]);
  const task = taskId ? allTasks.find((t) => t.id === taskId) ?? null : null;
  const newPhase = newIn ? phases.find((p) => p.id === newIn) ?? null : null;
  const edit = usePlanEdit();

  return (
    <>
      <OutcomeCard project={project} />
      <ApproveBar project={project} />
      <ProblemsBanner />
      <div className="lanes">
        {phases.map((phase, i) => {
          const prev = phases[i - 1];
          return (
            <Fragment key={phase.id}>
              {prev && (
                <div className={`merge${prev.status === "done" ? " done" : ""}`}>
                  {prev.status === "done" ? "Merged into main" : "Merges into main after review"}
                </div>
              )}
              <PhaseLane phase={phase} total={phases.length} allTasks={allTasks} selectedId={taskId} onOpen={setTaskId} onAddTask={() => setNewIn(phase.id)} />
            </Fragment>
          );
        })}
        {edit && <AddPhase />}
      </div>
      {task && <TaskDrawer task={task} phase={phases.find((p) => p.tasks.some((t) => t.id === task.id))!} onClose={() => setTaskId(null)} />}
      {newPhase && (
        <Drawer label={`New task in phase ${newPhase.idx}`} onClose={() => setNewIn(null)}>
          <div className="drawer-head"><span className="muted">Phase {newPhase.idx}: {newPhase.title}</span></div>
          <h2 className="drawer-title">New task</h2>
          <TaskForm task={null} phase={newPhase} onDone={() => setNewIn(null)} />
        </Drawer>
      )}
    </>
  );
}

// ─────────── phase lane ───────────

function PhaseLane({ phase, total, allTasks, selectedId, onOpen, onAddTask }: { phase: Phase; total: number; allTasks: Task[]; selectedId: string | null; onOpen: (id: string) => void; onAddTask: () => void }) {
  const state = phaseState(phase);
  const done = phase.tasks.filter((t) => isDone(t.status)).length;
  const edit = usePlanEdit();
  const bad = edit ? problemsFor(edit.problems, { phaseIdx: phase.idx }).length > 0 : false;
  return (
    <section className={`card graph-card lane lane-${state}${bad ? " has-problem" : ""}`} aria-label={`Phase ${phase.idx}: ${phase.title}`}>
      <div className="graph-head">
        <div>
          <div className="graph-kicker">Phase {phase.idx} of {total}</div>
          <h2>{phase.title}</h2>
          {phase.goalPlain ? (
            <p className="graph-goal">{phase.visible && <Icon name="eye" size={14} className="muted" />} {phase.goalPlain}</p>
          ) : (
            state !== "done" && <p className="muted graph-goal">{phase.goal}</p>
          )}
          {edit && <PhaseActions key={`${phase.id}-${phase.title}-${phase.goal}`} phase={phase} onAddTask={onAddTask} />}
        </div>
        <div className="graph-meta">
          <Badge value={phase.status} />
          <span className="graph-count">
            {done}<span className="muted">/{phase.tasks.length}</span>
          </span>
        </div>
      </div>
      <TaskGraph phase={phase} allTasks={allTasks} selectedId={selectedId} onOpen={onOpen} />
      <div className="graph-foot">
        <span className="mono muted small">{phase.branch}</span>
        {state === "active" && (
          <span className="graph-legend">
            <span><i className="dot tone-lime" /> done</span>
            <span><i className="dot tone-violet" /> in progress</span>
            <span><i className="dot tone-amber" /> rework</span>
            <span><i className="dot tone-muted" /> waiting</span>
          </span>
        )}
      </div>
    </section>
  );
}

// ─────────── task graph ───────────

type Edge = { from: string; to: string; done: boolean };

function TaskGraph({ phase, allTasks, selectedId, onOpen }: { phase: Phase; allTasks: Task[]; selectedId: string | null; onOpen: (id: string) => void }) {
  const tasks = phase.tasks;
  const keyOf = useMemo(() => new Map(allTasks.map((t) => [t.id, t.key])), [allTasks]);
  const edit = usePlanEdit();
  const badKeys = new Set((edit?.problems ?? []).map((p) => p.taskKey).filter(Boolean));

  // Depth inside this phase: 0 when every dependency is outside it.
  const columns = useMemo(() => {
    const inPhase = new Map(tasks.map((t) => [t.key, t]));
    const memo = new Map<string, number>();
    const depth = (t: Task, seen = new Set<string>()): number => {
      if (memo.has(t.key)) return memo.get(t.key)!;
      if (seen.has(t.key)) return 0;
      seen.add(t.key);
      const local = t.dependsOnKeys.map((k) => inPhase.get(k)).filter((x): x is Task => !!x);
      const d = local.length ? 1 + Math.max(...local.map((x) => depth(x, seen))) : 0;
      memo.set(t.key, d);
      return d;
    };
    const cols: Task[][] = [];
    for (const t of tasks) (cols[depth(t)] ??= []).push(t);
    return cols.filter(Boolean);
  }, [tasks]);

  const edges: Edge[] = useMemo(() => {
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    return tasks.flatMap((t) =>
      t.dependsOnKeys.filter((k) => byKey.has(k)).map((k) => ({ from: byKey.get(k)!.id, to: t.id, done: isDone(byKey.get(k)!.status) })),
    );
  }, [tasks]);

  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<{ d: string; done: boolean; key: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      setPaths(
        edges.flatMap((e) => {
          const a = nodes.current.get(e.from)?.getBoundingClientRect();
          const b = nodes.current.get(e.to)?.getBoundingClientRect();
          if (!a || !b) return [];
          const x1 = a.right - r.left;
          const y1 = a.top + a.height / 2 - r.top;
          const x2 = b.left - r.left;
          const y2 = b.top + b.height / 2 - r.top;
          const dx = Math.max(24, (x2 - x1) / 2);
          return [{ key: `${e.from}-${e.to}`, done: e.done, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` }];
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [edges, columns]);

  return (
    <div className="graph" ref={box}>
      <svg className="graph-edges" width={size.w} height={size.h} aria-hidden="true">
        {paths.map((p) => (
          <path key={p.key} d={p.d} className={p.done ? "edge done" : "edge"} />
        ))}
      </svg>
      {columns.map((col, ci) => (
        <div className="graph-col" key={ci}>
          {col.map((t) => {
            const external = t.dependsOnKeys.filter((k) => !tasks.some((x) => x.key === k));
            return (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) nodes.current.set(t.id, el);
                  else nodes.current.delete(t.id);
                }}
                className={`node tone-${toneOf(t.status)}${RUNNING.includes(t.status) ? " live" : ""}${selectedId === t.id ? " selected" : ""}${badKeys.has(t.key) ? " has-problem" : ""}`}
                onClick={() => onOpen(t.id)}
              >
                <span className="node-top">
                  <i className="dot" />
                  <span className="mono node-key">{t.key}</span>
                  {isDone(t.status) ? <Icon name="check" size={15} className="node-check" /> : <span className="node-status">{t.status}</span>}
                </span>
                <span className="node-title">{t.title}</span>
                <span className="node-meta">
                  <span>{t.model ?? "—"}{t.effort ? ` · ${t.effort}` : ""}</span>
                  {t.attempts > 0 && <span className="node-attempts">attempt {t.attempts}/{t.maxAttempts}</span>}
                  {t.modelSource === "owner" && <span className="node-owner" title="Model set by you">yours</span>}
                  {t.tokens > 0 && <span>{fmtTokens(t.tokens)}</span>}
                </span>
                {external.length > 0 && (
                  <span className="node-after">after {external.map((k) => keyOf.get(k) ?? k).join(", ")}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─────────── drawer ───────────

function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <button className="round-btn drawer-close" onClick={onClose} aria-label="Close">
          <Icon name="plus" size={18} className="rot45" />
        </button>
        {children}
      </aside>
    </div>
  );
}

function TaskDrawer({ task: t, phase, onClose }: { task: Task; phase: Phase; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  const retry = useMutation({ mutationFn: (m?: string) => api.retryTask(t.id, m), onSuccess: refresh });
  const skip = useMutation({ mutationFn: () => api.skipTask(t.id), onSuccess: refresh });
  const edit = usePlanEdit();
  const [editing, setEditing] = useState(false);
  const canRetry = ["failed", "escalated", "rework", "interrupted"].includes(t.status);
  const canSkip = !["running", "verifying", "reviewing", "done", "skipped"].includes(t.status);
  const canEdit = !!edit && t.editable === true;
  const lock = edit && !t.editable && !isDone(t.status) ? lockText(t.lockedReason) : null;

  return (
    <Drawer label={`Task ${t.key}`} onClose={onClose}>
      <div className="drawer-head">
        <span className="mono drawer-key">{t.key}</span>
        <Badge value={t.status} />
        {t.modelSource === "owner" && <span className="pill pill-soft">model set by you</span>}
      </div>
      <h2 className="drawer-title">{editing ? "Edit task" : t.title}</h2>
      {editing ? (
        <>
          <TaskForm task={t} phase={phase} onDone={() => setEditing(false)} />
          <h4>Place in the plan</h4>
          <TaskMoveDelete task={t} onDeleted={onClose} />
        </>
      ) : (
        <>
          {t.lastFeedback && !isDone(t.status) && (
            <div className="fix">
              <strong>What to fix</strong>
              <Expandable text={t.lastFeedback} lines={6} />
            </div>
          )}
          <div className="drawer-stats">
            <div><span className="muted">Model</span>{t.model ?? "—"}{t.effort ? ` · ${t.effort}` : ""}</div>
            <div><span className="muted">Attempts</span>{t.attempts}/{t.maxAttempts}</div>
            <div><span className="muted">Runs</span>{t.runs}</div>
            <div><span className="muted">Tokens</span>{t.tokens ? fmtTokens(t.tokens) : "—"}</div>
          </div>
          {(canRetry || canSkip || canEdit) && (
            <div className="drawer-actions">
              {canRetry && <button className="primary" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>Retry</button>}
              {canEdit && <button className={canRetry ? "ghost" : "primary"} onClick={() => setEditing(true)}>Edit task</button>}
              {canSkip && (
                <button className="ghost" disabled={skip.isPending} onClick={() => confirm(`Skip ${t.key}? Tasks depending on it will be released.`) && skip.mutate()}>
                  Skip task
                </button>
              )}
            </div>
          )}
          {lock && <p className="lock-note"><Icon name="lock" size={13} />Read-only: {lock}</p>}
          <ErrorText error={retry.error ?? skip.error} />
          <TaskDetail t={t} canRetry={canRetry} onRetry={(m) => retry.mutate(m)} hideFeedback={!isDone(t.status)} />
        </>
      )}
    </Drawer>
  );
}

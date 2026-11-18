/**
 * Where a project is on its way from idea to done (SPEC §5.1, §17.2): the stops depend
 * on the mode, the position comes from the status (or, when blocked, from where it was).
 */
import type { Project, ProjectStatus, TaskStatus } from "../api";
import { Icon } from "./Icon";

type StageId = "sketch" | "agree" | "design" | "pick" | "plan" | "approve" | "build" | "done";
export type StageState = "done" | "running" | "waiting" | "blocked" | "paused" | "todo";
export type Stage = { id: StageId; label: string; state: StageState };

const STOPS: Record<Project["mode"], { id: StageId; label: string }[]> = {
  scratch: [
    { id: "design", label: "Architect" },
    { id: "plan", label: "Plan" },
    { id: "approve", label: "You approve" },
    { id: "build", label: "Build" },
    { id: "done", label: "Done" },
  ],
  existing: [
    { id: "design", label: "Map repo" },
    { id: "pick", label: "You pick" },
    { id: "plan", label: "Plan" },
    { id: "approve", label: "You approve" },
    { id: "build", label: "Build" },
    { id: "done", label: "Done" },
  ],
  rework: [
    { id: "design", label: "Baseline" },
    { id: "pick", label: "You confirm" },
    { id: "plan", label: "Plan" },
    { id: "approve", label: "You approve" },
    { id: "build", label: "Build" },
    { id: "done", label: "Done" },
  ],
};

/** Sketch-first projects (SPEC §22.7): a sketch to agree on comes before the plan. */
const SKETCH_STOPS: { id: StageId; label: string }[] = [
  { id: "sketch", label: "Sketch" },
  { id: "agree", label: "You agree" },
  { id: "plan", label: "Plan" },
  { id: "approve", label: "You approve" },
  { id: "build", label: "Build" },
  { id: "done", label: "Done" },
];

type StageInput = Pick<Project, "mode" | "status" | "blockedFrom" | "ownerGate" | "paused" | "sketch">;

function stageOf(status: ProjectStatus, gate: Project["ownerGate"], sketch: boolean): StageId | null {
  switch (status) {
    case "draft": return null;
    case "sketching": return "sketch";
    case "architecting": case "mapping": return sketch ? "plan" : "design";
    case "planning": return "plan";
    case "awaiting_owner": return gate === "approve_plan" ? "approve" : gate === "approve_sketch" ? "agree" : sketch ? "agree" : "pick";
    case "executing": return "build";
    case "done": return "done";
    default: return null;
  }
}

export function stagesFor(p: StageInput): { stages: Stage[]; current: number } {
  const stops = p.sketch ? SKETCH_STOPS : (STOPS[p.mode] ?? STOPS.scratch);
  const at = stageOf(p.status === "blocked" ? (p.blockedFrom ?? "draft") : p.status, p.ownerGate, !!p.sketch);
  const current = p.status === "done" ? stops.length : at ? stops.findIndex((s) => s.id === at) : -1;
  const live: StageState =
    p.status === "blocked" ? "blocked" : p.paused ? "paused" : p.status === "awaiting_owner" ? "waiting" : "running";
  return {
    current,
    stages: stops.map((s, i) => ({ ...s, state: i < current ? "done" : i === current ? (s.id === "done" ? "done" : live) : "todo" })),
  };
}

/** Compact stop line for project cards; only the current stop is named. */
export function StageLine({ p }: { p: StageInput }) {
  const { stages, current } = stagesFor(p);
  const last = stages.length - 1;
  const fill = current <= 0 ? 0 : (Math.min(current, last) / last) * 100;
  const now = stages[current];
  return (
    <div className="stage-line" role="img" aria-label={now ? `Stage: ${now.label} (${now.state})` : p.status === "done" ? "All stages done" : "Not started"}>
      <div className="stops" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}>
        <span className="stops-rail" style={{ left: `${50 / stages.length}%`, right: `${50 / stages.length}%` }}>
          <b style={{ width: `${fill}%` }} />
        </span>
        {stages.map((s) => (
          <span key={s.id} className={`stop st-${s.state}${s === now ? " now" : ""}`} title={s.label} />
        ))}
      </div>
      <div className="stop-labels" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}>
        {stages.map((s) => (
          <span key={s.id}>{s === now ? s.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

const STATE_TEXT: Record<StageState, string> = {
  done: "Done", running: "In progress", waiting: "Waiting for you", blocked: "Blocked", paused: "Paused", todo: "Not yet",
};

/** Big stage track for the project page; `detail` adds a line under a stop (e.g. "Phase 2 of 3"). */
export function StageTrack({ p, detail = {} }: { p: StageInput; detail?: Partial<Record<StageId, string>> }) {
  const { stages } = stagesFor(p);
  return (
    <div className="card track-card">
      <ol className="track" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(120px, 1fr))` }}>
        {stages.map((s, i) => (
          <li key={s.id} className={`track-step st-${s.state}${i > 0 && stages[i - 1]!.state === "done" ? " after-done" : ""}`}>
            <div className="track-inner">
              <span className="track-node">{s.state === "done" ? <Icon name="check" size={16} /> : i + 1}</span>
              <span className="track-title">{s.label}</span>
              <span className="track-count">{detail[s.id] ?? STATE_TEXT[s.state]}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const TICK: Partial<Record<TaskStatus, string>> = {
  done: "done", skipped: "done", running: "run", verifying: "run", reviewing: "run",
  rework: "warn", interrupted: "warn", failed: "bad", escalated: "bad", ready: "ready",
};

/** One tick per task, in plan order. */
export function TaskTicks({ states }: { states: TaskStatus[] }) {
  if (!states.length) return null;
  const done = states.filter((s) => s === "done" || s === "skipped").length;
  return (
    <div className="ticks" role="img" aria-label={`${done} of ${states.length} tasks done`}>
      {states.map((s, i) => (
        <i key={i} className={TICK[s] ?? ""} title={s} />
      ))}
    </div>
  );
}

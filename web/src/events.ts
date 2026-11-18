import type { IconName } from "./components/Icon";

/** Icon and short category per event type, used instead of the raw type name. */
export function eventKind(type: string): { icon: IconName; label: string } {
  const K: Record<string, { icon: IconName; label: string }> = {
    task_status: { icon: "check", label: "Task" }, task_recovered: { icon: "refresh", label: "Task" },
    phase_status: { icon: "layers", label: "Phase" }, project_status: { icon: "flag", label: "Project" },
    project_created: { icon: "plus", label: "Project" }, project_settings: { icon: "gear", label: "Settings" },
    run_finished: { icon: "robot", label: "Run" }, scheduler_step: { icon: "pulse", label: "Scheduler" },
    scheduler_error: { icon: "alert", label: "Error" }, limit_probe: { icon: "clock", label: "Quota" },
    owner_answer: { icon: "user", label: "You" }, owner_choice: { icon: "user", label: "You" },
    review_decision: { icon: "eye", label: "Review" }, plan_persisted: { icon: "list", label: "Plan" },
    plan_edited: { icon: "list", label: "Plan" }, plan_approved_by_owner: { icon: "play", label: "Plan" },
    merged_into_base: { icon: "branch", label: "Merge" }, mapper_changes_reverted: { icon: "alert", label: "Mapper" },
    sandbox_created: { icon: "shield", label: "Copy" },
    session_claimed: { icon: "terminal", label: "Session" }, session_released: { icon: "terminal", label: "Session" },
    session_rotated: { icon: "refresh", label: "Session" }, session_slot_unavailable: { icon: "alert", label: "Session" },
  };
  return K[type] ?? { icon: "pulse", label: type.replace(/_/g, " ") };
}

/** Human-readable one-liners for event rows (shared by the system log and the activity tab). */
export function describeEvent(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case "task_status":
      return `${p.key}  ${p.from} → ${p.to}`;
    case "task_recovered":
      return `${p.key}  recovered after restart`;
    case "phase_status":
      return `phase ${p.idx}  ${p.from} → ${p.to}`;
    case "project_status":
      return `project  ${p.from} → ${p.to}${p.reason ? `  (${String(p.reason).slice(0, 100)})` : ""}`;
    case "project_created":
      return `project created`;
    case "project_settings":
      return Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(" ");
    case "run_finished":
      return `${String(p.kind).replace("_", " ")} run ${p.aborted ? "aborted" : p.errorKind ? `ended: ${p.errorKind}` : "ok"}`;
    case "scheduler_step":
      return String(p.message ?? "");
    case "scheduler_error":
      return `error: ${p.message}`;
    case "limit_probe":
      return `limit probe ${p.ok ? "ok" : `blocked${p.reason ? ` (${p.reason})` : ""}`}`;
    case "owner_answer":
      return `owner answered: ${String(p.message ?? "").slice(0, 100)}`;
    case "review_decision":
      return `review ${p.target}: ${p.decision}`;
    case "owner_choice": {
      const picked = Array.isArray(p.picked) ? p.picked : [];
      return `owner chose ${picked.length} proposal${picked.length === 1 ? "" : "s"}${picked.length ? `: ${picked.join(", ")}` : ""}`;
    }
    case "mapper_changes_reverted":
      return `mapper changed ${p.count} file${p.count === 1 ? "" : "s"} outside .aipm/, reverted`;
    case "merged_into_base":
      return `merged ${p.commits} commit${p.commits === 1 ? "" : "s"} from ${p.from} into ${p.into}`;
    case "plan_edited":
      return `owner edited the plan: ${String(p.op).replace("_", " ")}${p.taskKey ? ` ${p.taskKey}` : p.phaseIdx != null ? ` phase ${p.phaseIdx}` : ""}`;
    case "sandbox_created":
      return `working copy created from ${p.source}`;
    case "plan_approved_by_owner":
      return "owner approved the plan and started the build";
    case "session_claimed":
      return `took session slot #${p.slot}`;
    case "session_released":
      return `freed session slot #${p.slot}${p.reason === "owner" ? " (by owner)" : " (project done)"} after ${p.runs} runs`;
    case "session_rotated":
      return `slot #${p.slot} starts a fresh session: ${p.reason === "too_large" ? `context reached ${Math.round(Number(p.contextTokens) / 1000)}k` : p.reason === "resume_failed" ? "old session could not be resumed" : "reset by owner"}`;
    case "session_slot_unavailable":
      return `waiting for a free session slot (all ${p.slots} in use)`;
    case "plan_persisted":
      return `plan stored: ${p.phases} phases, ${p.tasks} tasks`;
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 160) : "";
  }
}

/** Visual weight of an event in the log. */
export function eventTone(type: string, p: Record<string, unknown>): "hi" | "ok" | "warn" | "bad" | "dim" {
  if (type === "scheduler_error" || p.to === "failed" || p.to === "blocked" || p.to === "escalated" || p.errorKind === "crash") return "bad";
  if (p.to === "done" || type === "plan_persisted" || type === "merged_into_base" || type === "owner_choice" || type === "plan_approved_by_owner" || p.decision === "approve") return "ok";
  if (type === "mapper_changes_reverted" || type === "session_slot_unavailable") return "warn";
  if (p.decision === "escalate") return "bad";
  if (p.decision === "rework") return "warn";
  if (p.to === "rework" || p.to === "interrupted" || p.errorKind === "limit" || type === "limit_probe") return "warn";
  if (type === "run_finished" || type === "scheduler_step") return "dim";
  return "hi";
}

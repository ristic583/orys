import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ago, api, fmtDate, fmtTime, fmtTokens, PRIORITY_LABEL, RUNNABLE_STATUSES, type EventRow, type Job, type ProjectSummary, type UsageRow } from "../api";
import { elapsed, useNow } from "../hooks";
import { AreaChart, Heatmap, ShareStrip } from "../components/Charts";
import { Icon } from "../components/Icon";
import { describeEvent, eventTone } from "../events";
import { Link } from "../router";
import { StageLine, TaskTicks } from "../components/Stages";
import { OwnerMetricsStrip } from "../components/Outcome";
import { Badge, Empty, ErrorText, Segmented } from "../ui";

const KIND_LABEL: Record<string, string> = { worker: "Workers", master_review: "Reviews", architect: "Architect", mapper: "Mapper", planner: "Planner", probe: "Probes" };

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Local YYYY-MM-DD for the last `n` days, oldest first. */
function lastDays(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return d.toLocaleDateString("sv-SE");
  });
}
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });

export function Overview() {
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  // Twice the range, so the headline can compare with the previous period.
  const usage = useQuery({ queryKey: ["usage", days * 2], queryFn: () => api.usage(days * 2) });
  const runs = useQuery({ queryKey: ["runs", { all: true }], queryFn: () => api.runs({ limit: 500 }) });

  const range = lastDays(days);
  const prevRange = new Set(lastDays(days * 2).slice(0, days));
  const rows = usage.data?.rows ?? [];
  const inRange = rows.filter((r) => range.includes(r.day));
  const sum = (rs: UsageRow[], f: (r: UsageRow) => number) => rs.reduce((a, r) => a + f(r), 0);
  const tokens = sum(inRange, (r) => r.tokens);
  const prevTokens = sum(rows.filter((r) => prevRange.has(r.day)), (r) => r.tokens);
  const delta = prevTokens > 0 ? ((tokens - prevTokens) / prevTokens) * 100 : null;
  const perDay = range.map((d) => sum(inRange.filter((r) => r.day === d), (r) => r.tokens));
  const cachePerDay = range.map((d) => sum(inRange.filter((r) => r.day === d), (r) => r.cacheRead));
  const byKind = Object.entries(KIND_LABEL)
    .map(([k, label]) => ({ label, value: sum(inRange.filter((r) => r.kind === k), (r) => r.tokens) }))
    .filter((k) => k.value > 0);
  const activeDays = perDay.filter((v) => v > 0).length || 1;

  const list = projects.data ?? [];
  const totalTasks = list.reduce((a, p) => a + p.tasksTotal, 0);
  const doneTasks = list.reduce((a, p) => a + p.tasksDone, 0);
  const jobs = status.data?.scheduler?.jobs ?? [];
  const limit = status.data?.limit;
  const [whole, frac] = splitTokens(tokens);
  const since = new Date(Date.now() - days * 864e5);
  const runTimes = (runs.data ?? []).map((r) => new Date(r.startedAt)).filter((d) => d >= since);

  const needs = list.filter((p) => p.status === "blocked" || p.status === "awaiting_owner");
  const headline = needs.length
    ? `${count(needs.length)} project${needs.length > 1 ? "s" : ""} need${needs.length > 1 ? "" : "s"} you.`
    : jobs.length
      ? `${jobs.map((j) => j.slug).join(", ")} ${jobs.length > 1 ? "are" : "is"} in progress.`
      : "all quiet.";

  return (
    <>
      <h1 className="headline">
        {greeting()}, <span className="muted-strong">{headline}</span>
      </h1>

      <OwnerMetricsStrip />
      {needs.length > 0 && (
        <section className="needs" aria-label="Needs you">
          {needs.map((p) => (
            <NeedCard key={p.id} p={p} />
          ))}
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Projects</h2>
          <span className="muted">
            {list.length} total{jobs.length ? ` · ${jobs.length} working now` : ""}
          </span>
          <Link to="/new" className="btn-white sm push">
            New project <Icon name="plus" size={15} />
          </Link>
        </div>
        {projects.isLoading ? (
          <p className="muted">Loading…</p>
        ) : projects.error ? (
          <ErrorText error={projects.error} />
        ) : !list.length ? (
          <Empty>
            No projects yet. <Link to="/new">Create the first one</Link>
          </Empty>
        ) : (
          <div className="project-grid">
            {list.map((p) => (
              <ProjectCard key={p.id} p={p} job={jobs.find((j) => j.slug === p.slug)} quotaUntil={limit?.blocked && !p.paused && RUNNABLE_STATUSES.includes(p.status) ? (limit.blockedUntil ?? "") : null} />
            ))}
          </div>
        )}
      </section>

      <section className="usage-section">
        <div className="section-head">
          <h2>This week</h2>
          <Segmented
            label="Range"
            value={days}
            onChange={setDays}
            options={[
              { id: 7, label: "Week" },
              { id: 14, label: "2 weeks" },
              { id: 30, label: "Month" },
            ]}
          />
          <Link to="/usage" className="muted small push">
            Open usage <Icon name="arrowDownRight" size={14} />
          </Link>
        </div>
        <div className="card hero-body">
          <div className="hero-stat">
            <div className="stat-label">Tokens used</div>
            <div className="stat-big">
              {whole}
              <span className="stat-frac">{frac}</span>
              {delta != null && <span className={`stat-delta ${delta > 0 ? "up" : "down"}`}>{delta > 0 ? "+" : ""}{delta.toFixed(1)}%</span>}
            </div>
            <div className="stat-sub">
              Tasks done: <strong>{doneTasks}/{totalTasks}</strong>
              {limit?.utilization != null && (
                <>
                  {"  ·  "}Quota: <strong>{Math.round(limit.utilization * 100)}%</strong>
                  {limit.resetAt && <span className="muted"> (resets {new Date(limit.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</span>}
                </>
              )}
            </div>
          </div>
          <ShareStrip items={byKind} average={`Avg ${fmtTokens(tokens / activeDays)} / active day`} from={shortDay(range[0]!)} to={shortDay(range.at(-1)!)} />
        </div>
      </section>

      <section className="grid-3">
        <div className="card">
          <div className="card-head">
            <span className="card-icon"><Icon name="chart" /></span>
            <h2>Throughput</h2>
          </div>
          <div className="legend">
            <span><i className="swatch sw-lime" /> Tokens</span>
            <span><i className="swatch sw-ghost" /> Cache reads</span>
          </div>
          <AreaChart
            labels={range.map(shortDay)}
            series={[
              { label: "tokens", values: perDay, tone: "lime" },
              { label: "cache reads", values: cachePerDay, tone: "ghost" },
            ]}
          />
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-icon"><Icon name="clock" /></span>
            <h2>Activity by time</h2>
            <span className="muted small push">{runTimes.length} runs</span>
          </div>
          <Heatmap times={runTimes} />
        </div>

        <RecentActivity />
      </section>
    </>
  );
}

/** Card subtitle when no phase is active yet. */
const STATUS_LINE: Record<string, string> = {
  draft: "Not started",
  sketching: "Sketching: something to look at in minutes",
  "gate:approve_sketch": "Sketch ready: take a look",
  mapping: "Mapping the repository",
  architecting: "Architect at work",
  planning: "Planning",
  "gate:pick_proposals": "Waiting for you to pick proposals",
  "gate:confirm_goal": "Waiting for you to confirm the goal",
  "gate:approve_plan": "Waiting for you to approve the plan",
  blocked: "Blocked, needs your answer",
  done: "Finished",
};

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const count = (n: number) => (WORDS[n] ?? String(n)).toLowerCase();

const GATE_ACTION: Record<string, string> = { approve_sketch: "Look at the sketch", approve_plan: "Review plan", pick_proposals: "Pick proposals", confirm_goal: "Confirm goal" };
const GATE_TEXT: Record<string, string> = {
  approve_sketch: "A first sketch is ready. Say what to change, or agree and let Orys build it properly.",
  approve_plan: "The plan is reviewed and ready. Approve it or edit it before anything is built.",
  pick_proposals: "The mapper finished. Pick which proposals become the goal.",
  confirm_goal: "The baseline is mapped. Confirm the goal before planning starts.",
};

function NeedCard({ p }: { p: ProjectSummary }) {
  const blocked = p.status === "blocked";
  const gate = p.ownerGate ?? "approve_plan";
  return (
    <Link to={`/projects/${p.slug}`} className={`card need ${blocked ? "need-bad" : "need-warn"}`}>
      <span className="need-icon" aria-hidden="true">{blocked ? "!" : "?"}</span>
      <h3>{p.name}</h3>
      <p>{blocked ? p.blockedReason ?? "Blocked. Open the project to answer." : GATE_TEXT[gate]}</p>
      <span className={blocked ? "ghost need-act tone-red-btn" : "btn-white sm need-act"}>{blocked ? "Answer" : GATE_ACTION[gate]}</span>
    </Link>
  );
}

/** "643k" → ["643", "k"], "1.2M" → ["1.2", "M"]: the unit is drawn muted. */
function splitTokens(n: number): [string, string] {
  const s = fmtTokens(n);
  const m = /^([\d.]+)([kM]?)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, ""];
}

function RecentActivity() {
  const { data } = useQuery({ queryKey: ["events", "all"], queryFn: () => api.allEvents(30), retry: false });
  const rows = (data ?? []).filter((e) => e.type !== "run_finished" && e.type !== "scheduler_step").slice(0, 6);
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-icon"><Icon name="pulse" /></span>
        <h2>Recent activity</h2>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ul className="activity">
          {rows.map((e) => (
            <ActivityRow key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

const CATEGORY: Record<string, string> = {
  task_status: "Task", task_recovered: "Task", phase_status: "Phase", project_status: "Project", review_decision: "Review",
  limit_probe: "Quota", owner_answer: "Owner", plan_persisted: "Plan", project_created: "Project", project_settings: "Settings", scheduler_error: "Error",
  owner_choice: "Owner", mapper_changes_reverted: "Mapper", merged_into_base: "Merge", plan_edited: "Plan", plan_approved_by_owner: "Plan",
};

function ActivityRow({ e }: { e: EventRow }) {
  const p = e.payload;
  const title =
    (p.key as string | undefined) ??
    (e.type === "phase_status" ? `Phase ${p.idx}` : e.type === "review_decision" ? `${String(p.target).replace(/^./, (c) => c.toUpperCase())} review` : e.projectSlug ?? "System");
  const to = (p.to as string | undefined) ?? (p.decision as string | undefined);
  const tone = eventTone(e.type, p);
  return (
    <li title={describeEvent(e.type, p)}>
      <span className="act-title">{title}</span>
      <span className={`pill pill-soft tone-${tone === "ok" ? "lime" : tone === "bad" ? "red" : tone === "warn" ? "amber" : "violet"}`}>
        <i className="dot" />
        {CATEGORY[e.type] ?? e.type}
      </span>
      <span className="act-value">{to ?? new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    </li>
  );
}

function ProjectCard({ p, job, quotaUntil }: { p: ProjectSummary; job?: Job; quotaUntil: string | null }) {
  const now = useNow(1000);
  const working = !!job;
  const pct = p.tasksTotal ? Math.round((p.tasksDone / p.tasksTotal) * 100) : 0;
  const overdue = p.deadline && new Date(p.deadline) < new Date() && p.status !== "done";
  return (
    <Link to={`/projects/${p.slug}`} className={`card project-card${working ? " working" : ""}`}>
      <div className="card-head">
        <h3>{p.name}</h3>
        <Badge value={quotaUntil != null && !working ? "waiting" : p.status}>{working ? "running" : p.paused ? "paused" : quotaUntil != null ? "waiting for quota" : p.status}</Badge>
      </div>
      <div className="pc-main">
        <div className="pc-pct">
          {pct}
          <span>%</span>
        </div>
        <div className="pc-meta">
          <div>{p.tasksDone} of {p.tasksTotal || "?"} tasks</div>
          <div className="muted">{p.currentPhase ? `Phase ${p.currentPhase.idx}/${p.phasesTotal} · ${p.currentPhase.title}` : STATUS_LINE[p.status === "awaiting_owner" ? `gate:${p.ownerGate}` : p.status] ?? p.status}</div>
        </div>
      </div>
      <StageLine p={p} />
      <TaskTicks states={p.taskStates ?? Array.from({ length: p.tasksTotal }, (_, i) => (i < p.tasksDone ? "done" : "pending"))} />
      {job && <LiveLine job={job} now={now} />}
      {!job && quotaUntil != null && <p className="pc-live muted small">Waiting for the Claude quota{quotaUntil ? ` · back at ${fmtTime(quotaUntil)}` : ""}. It continues by itself.</p>}
      {p.blockedReason && <p className="pc-blocked">Needs your input: {p.blockedReason}</p>}
      <div className="pc-foot">
        <span className="pill pill-soft tone-neutral" title={`Priority ${p.priority} of 5`}>{PRIORITY_LABEL[p.priority] ?? p.priority} priority</span>
        <span className="pill pill-soft tone-neutral">{p.profile}</span>
        {p.deadline && <span className={`pill pill-soft ${overdue ? "tone-red" : "tone-neutral"}`}>Due {fmtDate(p.deadline)}</span>}
        <span className="muted push small">{fmtTokens(p.tokens7d)} tok · {ago(p.lastRunAt)}</span>
      </div>
    </Link>
  );
}

const RUN_LABEL: Record<string, string> = { mapper: "Mapping", architect: "Architecture", planner: "Planning", worker: "Coding", master_review: "Review", probe: "Quota check" };

/** What the project's agent is doing right now. */
export function LiveLine({ job, now }: { job: Job; now: number }) {
  const r = job.run;
  const what = r ? `${RUN_LABEL[r.kind] ?? r.kind}${r.taskKey ? ` ${r.taskKey}` : ""}` : job.stage === "execution" ? "Checks and git" : "Working";
  return (
    <p className="pc-live small" title={r?.taskTitle ?? undefined}>
      <i className="pulse-dot" />
      <span>{what}</span>
      {job.activity && <span className="muted mono pc-activity">{job.activity}</span>}
      <span className="muted mono push">{elapsed(r?.startedAt ?? job.startedAt, now)}</span>
    </p>
  );
}

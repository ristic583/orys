import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtDate, fmtDateTime, fmtTime, fmtTokens, PRIORITY_LABEL, PROFILES, RUNNABLE_STATUSES, type ProjectDetail, type SessionSlot } from "../api";
import { useNow } from "../hooks";
import { LiveLine } from "./Overview";
import { Link, navigate, useLocation } from "../router";
import { describeEvent, eventKind, eventTone } from "../events";
import { Icon } from "../components/Icon";
import { RoleModels } from "../components/RoleModels";
import { StageTrack } from "../components/Stages";
import { StackRow } from "../components/Tech";
import { BaselineTiles, CommandPipeline, IconChip } from "../components/Visual";
import { OwnerChoice } from "../components/OwnerChoice";
import { RunList } from "../components/TaskParts";
import { Badge, Empty, ErrorText, Expandable, Markdown, Tabs } from "../ui";
import { PlanView } from "./PlanView";
import { HandoffCard } from "../components/Outcome";
import { SketchCard } from "../components/Sketch";

type TabId = "plan" | "architecture" | "goals" | "state" | "runs" | "decisions" | "activity" | "brief";
const TABS: { id: TabId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "architecture", label: "Architecture" },
  { id: "goals", label: "Goals" },
  { id: "state", label: "State" },
  { id: "runs", label: "Runs" },
  { id: "decisions", label: "Decisions" },
  { id: "activity", label: "Activity" },
  { id: "brief", label: "Brief" },
];

/** Existing and rework projects are mapped, not architected: the architecture doc is the map, and the owner's choice is the goals doc. */
function tabsFor(p: ProjectDetail) {
  if (p.mode === "scratch") return TABS.filter((t) => t.id !== "goals");
  return TABS.map((t) => (t.id === "architecture" ? { ...t, label: "Map" } : t));
}

export function ProjectPage({ id }: { id: string }) {
  const { search } = useLocation();
  const tab = (search.get("tab") as TabId | null) ?? "plan";
  const setTab = (t: TabId) => navigate(`/projects/${id}${t === "plan" ? "" : `?tab=${t}`}`);
  const { data: p, error } = useQuery({ queryKey: ["project", id], queryFn: () => api.project(id) });
  if (error) return <ErrorText error={error} />;
  if (!p) return <p className="muted">Loading…</p>;
  return (
    <>
      <Header p={p} />
      {p.sketch && <SketchCard project={p} />}
      {p.status === "done" && <HandoffCard project={p} />}
      {p.status === "blocked" && <UnblockBox p={p} />}
      {p.status === "mapping" && (
        <div className="callout info">
          <strong>Mapping the repository</strong>
          <p className="muted">
            The mapper agent is studying the code: stack, how to build and test it, the current quality, and what is missing. When it is done you choose what to work on;
            nothing is planned or changed before that. Orys writes only to <code>.aipm/</code> on the <code>{p.integrationBranch}</code> branch.
          </p>
        </div>
      )}
      {p.status === "awaiting_owner" && (p.ownerGate === "pick_proposals" || p.ownerGate === "confirm_goal") && <OwnerChoice p={p} />}
      <Tabs tabs={tabsFor(p)} value={tab} onChange={setTab} />
      <section className="tab-body">
        {tab === "plan" && <PlanTab p={p} />}
        {tab === "architecture" && (
          <>
            {p.mode !== "scratch" && <MapSummary projectId={p.id} />}
            <DocTab projectId={p.id} name="architecture" />
          </>
        )}
        {tab === "goals" && <DocTab projectId={p.id} name="goals" />}
        {tab === "state" && <DocTab projectId={p.id} name="state" />}
        {tab === "runs" && <RunsTab projectId={p.id} />}
        {tab === "decisions" && <DecisionsTab projectId={p.id} />}
        {tab === "activity" && <ActivityTab projectId={p.id} />}
        {tab === "brief" && <BriefTab p={p} />}
      </section>
    </>
  );
}

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries();
}

function Header({ p }: { p: ProjectDetail }) {
  const refresh = useInvalidateAll();
  const patch = useMutation({ mutationFn: (body: Parameters<typeof api.patchProject>[1]) => api.patchProject(p.id, body), onSuccess: refresh });
  const start = useMutation({ mutationFn: () => api.start(p.id), onSuccess: refresh });
  const merge = useMutation({ mutationFn: () => api.mergeBase(p.id), onSuccess: (r) => { alert(`Merged ${r.commits} commit(s) into ${r.into}.`); refresh(); } });
  const phases = useQuery({ queryKey: ["phases", p.id], queryFn: () => api.phases(p.id) });
  const tasks = (phases.data ?? []).flatMap((ph) => ph.tasks);
  const done = tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const [models, setModels] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const overridden = p.effectiveRoles ? Object.values(p.effectiveRoles).filter((r) => r.source === "project").length : 0;
  return (
    <>
    <div className="project-header">
      <div className="ph-main">
        <div className="title-row">
          <h1>{p.name}</h1>
          <Badge value={p.status}>{p.paused ? "paused" : p.status.replace("_", " ")}</Badge>
          {p.mode !== "scratch" && <span className="pill pill-soft mode-tag">{p.mode === "existing" ? "Continuing existing project" : "Rework & test"}</span>}
          {p.workspace === "sandbox" && <span className="pill pill-soft mode-tag tone-amber"><i className="dot" />Test mode · working on a copy</span>}
          {p.session && <SessionChip s={p.session} />}
        </div>
        <ProjectLive projectId={p.id} paused={p.paused} status={p.status} />
        <p className="muted small mono repo-path">
          {p.repoPath}
          {p.workspace === "sandbox" ? (
            <> · copy of <span className="tone-violet-text">{p.sourcePath}</span> (never touched)</>
          ) : (
            p.baseBranch && <> · agents on <span className="tone-violet-text">{p.integrationBranch}</span> · your branch {p.baseBranch}</>
          )}
        </p>
      </div>
      <div className="ph-side">
        {tasks.length > 0 && (
          <div className="ph-progress">
            <span className="ph-pct">{pct}<span>%</span></span>
            <span className="muted small">{done} of {tasks.length} tasks</span>
          </div>
        )}
        <div className="toolbar">
          {p.status === "draft" ? (
            <button className="primary sm" onClick={() => start.mutate()} disabled={start.isPending}>Start</button>
          ) : p.status !== "done" ? (
            <button className="tool-btn" onClick={() => patch.mutate({ paused: !p.paused })} disabled={patch.isPending} title={p.paused ? "Let the scheduler work on this project again" : "Stop scheduling new steps"}>
              <Icon name={p.paused ? "play" : "pause"} size={14} />
              {p.paused ? "Resume" : "Pause"}
            </button>
          ) : null}
          <select className="tool-select" value={p.priority} onChange={(e) => patch.mutate({ priority: Number(e.target.value) })} aria-label="Priority" title="Priority (scheduler weight)">
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{PRIORITY_LABEL[n]} priority</option>)}
          </select>
          <select className="tool-select" value={p.profile} onChange={(e) => patch.mutate({ profile: e.target.value as ProjectDetail["profile"] })} aria-label="Profile" title="Optimization profile">
            {PROFILES.map((x) => <option key={x} value={x}>{x[0]!.toUpperCase() + x.slice(1)}</option>)}
          </select>
          {p.baseBranch && (p.paused || p.status === "done") && (
            <button className="tool-btn" onClick={() => confirm(`Merge ${p.integrationBranch} into ${p.baseBranch}?`) && merge.mutate()} disabled={merge.isPending} title={`Bring Orys's work into ${p.baseBranch}`}>
              <Icon name="arrowDownRight" size={14} />
              Merge into {p.baseBranch}
            </button>
          )}
          <input className="tool-date" type="date" value={p.deadline ? p.deadline.slice(0, 10) : ""} onChange={(e) => patch.mutate({ deadline: e.target.value || null })} aria-label="Deadline" title="Deadline" />
          {p.effectiveRoles && (
            <button className={`tool-btn${models ? " on" : ""}`} onClick={() => setModels(!models)} aria-expanded={models} title="Model and effort per role">
              Models{overridden ? ` · ${overridden} set` : ""}
            </button>
          )}
          <button className={`tool-btn${deleting ? " on" : ""}`} onClick={() => setDeleting(!deleting)} aria-expanded={deleting} title="Delete this project from Orys">
            <Icon name="x" size={14} />
            Delete
          </button>
        </div>
      </div>
      <ErrorText error={patch.error ?? start.error ?? merge.error} />
    </div>
    {models && <RoleModels p={p} />}
    {deleting && <DeletePanel p={p} onCancel={() => setDeleting(false)} />}
    </>
  );
}

/** Delete the project: shows what goes and what stays, and asks for the short name. */
function DeletePanel({ p, onCancel }: { p: ProjectDetail; onCancel: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [removeFolder, setRemoveFolder] = useState(false);
  const preview = useQuery({ queryKey: ["deletion", p.id], queryFn: () => api.deletionPreview(p.id) });
  const del = useMutation({
    mutationFn: () => api.deleteProject(p.id, typed, removeFolder),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["project", p.id] });
      void qc.invalidateQueries();
      navigate("/");
    },
  });
  const d = preview.data;
  return (
    <div className="callout bad delete-panel">
      <strong>Delete {p.name}?</strong>
      <ul className="delete-list">
        <li>Orys forgets the project: plan, tasks, runs{d ? ` (${d.runs})` : ""}, sketches, events and its session.</li>
        {d?.ownerRepo && <li>Your repository stays as it is: <code>{d.ownerRepo}</code>{p.workspace !== "sandbox" && p.integrationBranch ? <>, including the <code>{p.integrationBranch}</code> branch</> : null}.</li>}
        {d?.orysFolder && (
          <li>
            <label className="check delete-folder">
              <input type="checkbox" checked={removeFolder} onChange={(e) => setRemoveFolder(e.target.checked)} />
              <span>
                Also delete the folder Orys made, <code>{d.orysFolder.path}</code>
                {d.orysFolder.kind === "sandbox" ? " (the test copy, with work not yet moved to your repo)" : " (the project's code)"}. This cannot be undone.
              </span>
            </label>
          </li>
        )}
      </ul>
      <form className="delete-form" onSubmit={(e) => { e.preventDefault(); del.mutate(); }}>
        <label className="muted small delete-confirm-label" htmlFor="delete-confirm">Type <code>{p.slug}</code> to confirm</label>
        <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="delete-actions">
          <button type="submit" className="tone-red-btn tool-btn" disabled={typed.trim() !== p.slug || del.isPending}>
            {del.isPending ? "Deleting…" : "Delete project"}
          </button>
          <button type="button" className="ghost sm" onClick={onCancel}>Cancel</button>
        </div>
        <ErrorText error={preview.error ?? del.error} />
      </form>
    </div>
  );
}

function UnblockBox({ p }: { p: ProjectDetail }) {
  const refresh = useInvalidateAll();
  const [msg, setMsg] = useState("");
  const unblock = useMutation({ mutationFn: () => api.unblock(p.id, msg), onSuccess: () => { setMsg(""); refresh(); } });
  return (
    <div className="callout bad">
      <strong>Needs your input</strong> <span className="muted">(blocked during {p.blockedFrom})</span>
      <Expandable text={p.blockedReason ?? ""} lines={6} />
      <form onSubmit={(e) => { e.preventDefault(); unblock.mutate(); }}>
        <textarea rows={3} placeholder="Your answer goes to the next agent run, with a fresh attempt budget." value={msg} onChange={(e) => setMsg(e.target.value)} required />
        <ErrorText error={unblock.error} />
        <button type="submit" className="primary" disabled={unblock.isPending || !msg.trim()}>Answer and unblock</button>
      </form>
    </div>
  );
}

function PlanTab({ p }: { p: ProjectDetail }) {
  const { data, error } = useQuery({ queryKey: ["phases", p.id], queryFn: () => api.phases(p.id) });
  const active = data?.find((ph) => ph.status === "active" || ph.status === "reviewing" || ph.status === "blocked");
  const track = <StageTrack p={p} detail={active && data ? { build: `Phase ${active.idx} of ${data.length}` } : {}} />;
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.length)
    return (
      <>
        {track}
        <Empty>No plan yet. {p.sketch ? (p.status === "sketching" || p.ownerGate === "approve_sketch" ? "The planner writes it once you agree on the sketch above." : "The planner is turning the sketch you agreed on into a plan.") : p.mode === "scratch" ? "The planner writes it after the architecture is approved." : "The planner writes it after the map is reviewed and you choose what to work on."}</Empty>
      </>
    );
  return (
    <>
      {track}
      <PlanView phases={data} project={p} />
    </>
  );
}

// ─────────── Docs ───────────

/** The map's key facts drawn as logos, tiles and the gate pipeline, above the full document. */
function MapSummary({ projectId }: { projectId: string }) {
  const { data } = useQuery({ queryKey: ["map", projectId], queryFn: () => api.map(projectId) });
  const m = data?.map;
  if (!m) return null;
  return (
    <div className="card map-summary">
      {m.stack.length > 0 && <StackRow items={m.stack} />}
      <BaselineTiles baseline={m.baseline} />
      {m.verify_commands.length > 0 && <CommandPipeline commands={m.verify_commands} />}
    </div>
  );
}

function DocTab({ projectId, name }: { projectId: string; name: "architecture" | "goals" | "state" }) {
  const { data, error } = useQuery({ queryKey: ["doc", projectId, name], queryFn: () => api.doc(projectId, name) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (data.content == null) return <Empty>{data.path} has not been written yet.</Empty>;
  return <Markdown text={data.content} />;
}

// ─────────── Runs ───────────

function RunsTab({ projectId }: { projectId: string }) {
  const { data, error } = useQuery({ queryKey: ["runs", { projectId }], queryFn: () => api.runs({ projectId }) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.length) return <Empty>No runs yet.</Empty>;
  return <RunList runs={data} />;
}

// ─────────── Decisions / activity / brief ───────────

function DecisionsTab({ projectId }: { projectId: string }) {
  const { data, error } = useQuery({ queryKey: ["decisions", projectId], queryFn: () => api.decisions(projectId) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.length) return <Empty>No decisions yet.</Empty>;
  return (
    <ul className="decisions">
      {data.map((d) => (
        <li key={d.id} className={`decision kind-${d.kind}`}>
          <div className="decision-head">
            <span className="decision-icon" title={d.kind}><Icon name={d.kind === "approve" ? "check" : d.kind === "rework" ? "refresh" : "alert"} size={16} /></span>
            <strong>{d.kind === "approve" ? "Approved" : d.kind === "rework" ? "Sent back" : "Escalated"}</strong>
            <span className="key-chip">{d.target}{d.taskKey ? ` · ${d.taskKey}` : d.phaseIdx ? ` · phase ${d.phaseIdx}` : ""}</span>
            <span className="icon-chip" title={d.by}><Icon name={d.by === "owner" ? "user" : "robot"} size={13} />{d.by === "owner" ? "You" : "Reviewer"}</span>
            <span className="muted small push">{fmtDateTime(d.createdAt)}</span>
          </div>
          {d.kind === "approve" ? (
            (d.rationale || d.feedback) && (
              <details className="decision-why">
                <summary>Why</summary>
                {d.rationale && d.by === "reviewer" && <p>{d.rationale}</p>}
                {d.feedback && <p className="muted">{d.feedback}</p>}
              </details>
            )
          ) : (
            <>
              {d.rationale && d.by === "reviewer" && <Expandable text={d.rationale} lines={2} />}
              {d.feedback && <Expandable text={d.feedback} lines={2} />}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActivityTab({ projectId }: { projectId: string }) {
  const { data, error } = useQuery({ queryKey: ["events", projectId], queryFn: () => api.events(projectId) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.length) return <Empty>Nothing happened yet.</Empty>;
  return (
    <table className="events">
      <tbody>
        {data.map((e) => (
          <tr key={e.id} className={`tone-line-${eventTone(e.type, e.payload)}`}>
            <td className="small muted nowrap">{fmtDateTime(e.createdAt)}</td>
            <td className="nowrap"><span className={`icon-chip ev-${eventTone(e.type, e.payload)}`}><Icon name={eventKind(e.type).icon} size={13} />{eventKind(e.type).label}</span></td>
            <td className="small">{describeEvent(e.type, e.payload)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BriefTab({ p }: { p: ProjectDetail }) {
  return (
    <div className="brief">
      <h3>Problem</h3>
      <p className="prewrap">{p.problem}</p>
      {p.aspects.length > 0 && (
        <>
          <h3>What matters for quality</h3>
          <div className="brief-chips">{p.aspects.map((a) => <IconChip key={a} icon="target" tone="violet">{a}</IconChip>)}</div>
        </>
      )}
      {p.constraints.length > 0 && (
        <>
          <h3>Constraints</h3>
          <div className="brief-chips">{p.constraints.map((a) => <IconChip key={a} icon="lock">{a}</IconChip>)}</div>
        </>
      )}
      {p.features.length > 0 && (
        <>
          <h3>Features</h3>
          <div className="feature-cards">
            {[...p.features].sort((a, b) => b.priority - a.priority).map((f) => (
              <div key={f.id} className="feature-card" title={f.description || undefined}>
                <span className={`prio prio-${f.priority}`}>P{f.priority}</span>
                <strong>{f.title}</strong>
                {f.deadline && <span className="icon-chip"><Icon name="clock" size={13} />{fmtDate(f.deadline)}</span>}
                <Badge value={f.status}>{f.status.replace("_", " ")}</Badge>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="small muted">Created {fmtDateTime(p.createdAt)}</p>
    </div>
  );
}

/** The project's session slot at a glance; the Sessions page has the controls. */
function SessionChip({ s }: { s: SessionSlot }) {
  const max = useQuery({ queryKey: ["sessions"], queryFn: api.sessions }).data?.maxContext ?? 150_000;
  const pct = Math.min(100, (s.contextTokens / max) * 100);
  return (
    <Link to="/sessions" className="pill pill-soft mode-tag session-chip" title={s.sessionId ? `Claude session ${s.sessionId} · ${s.runs} builder runs` : "Slot claimed; the session starts with the first builder run"}>
      <Icon name="terminal" size={13} />
      Session #{s.idx}
      {s.sessionId ? (
        <>
          <span className="mini-bar"><i className={pct >= 90 ? "amber" : undefined} style={{ width: `${pct}%` }} /></span>
          <span className="mono">{fmtTokens(s.contextTokens)}</span>
        </>
      ) : (
        <span className="muted">new</span>
      )}
    </Link>
  );
}

/** Live line under the title: what the agent is doing now, or that the project waits for the quota. */
function ProjectLive({ projectId, paused, status }: { projectId: string; paused: boolean; status: string }) {
  const now = useNow(1000);
  const { data } = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5_000 });
  const job = data?.scheduler?.jobs?.find((j) => j.projectId === projectId);
  if (job) return <LiveLine job={job} now={now} />;
  if (data?.limit.blocked && !paused && RUNNABLE_STATUSES.includes(status)) {
    return <p className="pc-live muted small">Waiting for the Claude quota{data.limit.blockedUntil ? ` · back at ${fmtTime(data.limit.blockedUntil)}` : ""}. It continues by itself.</p>;
  }
  return null;
}

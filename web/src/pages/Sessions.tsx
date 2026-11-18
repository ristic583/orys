import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ago, api, fmtTokens, type SessionOverviewSlot } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../router";
import { ErrorText } from "../ui";

/** Project sessions (SPEC §17.7): one long-lived Claude session per project, created when it first runs. */
export function SessionsPage() {
  const { data, error } = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, refetchInterval: 10_000 });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const sessions = data.slots.filter((s) => s.projectId);
  const working = sessions.filter((s) => s.busy).length;

  return (
    <>
      <div className="hero-head">
        <h1>
          Sessions <span className="muted-strong">{sessions.length} {sessions.length === 1 ? "project" : "projects"}{working ? ` · ${working} working now` : ""}</span>
        </h1>
      </div>
      <div className="session-legend muted small">
        <span><Icon name="robot" size={14} /> builder runs continue the project's session</span>
        <span><Icon name="eye" size={14} /> reviews stay independent</span>
        <span><Icon name="refresh" size={14} /> fresh session past {fmtTokens(data.maxContext)}</span>
      </div>
      {!sessions.length && <p className="muted">No project has a session yet. Each project gets its own the first time an agent works on it.</p>}
      <div className="slot-grid">
        {sessions.map((s) => <SlotCard key={s.id} s={s} max={data.maxContext} />)}
      </div>
    </>
  );
}

function SlotCard({ s, max }: { s: SessionOverviewSlot; max: number }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const act = useMutation({ mutationFn: () => api.resetSession(s.projectId!), onSuccess: () => void qc.invalidateQueries() });
  const pct = Math.min(100, (s.contextTokens / max) * 100);
  const tone = pct >= 90 ? "amber" : "violet";
  const copy = async () => {
    if (!s.resumeCommand) return;
    try {
      await navigator.clipboard.writeText(s.resumeCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      prompt("Copy this command:", s.resumeCommand);
    }
  };
  return (
    <div className={`slot-card${s.busy ? " slot-busy" : ""}`}>
      <div className="slot-top">
        {s.busy ? (
          <span className="pill pill-soft tone-violet"><i className="pulse-dot" />agent working</span>
        ) : (
          <span className="pill pill-soft tone-lime"><i className="dot" />idle</span>
        )}
      </div>
      <Link to={`/projects/${s.projectSlug}`} className="slot-project">
        {s.projectName}
        <Icon name="arrowUpRight" size={16} />
      </Link>

      <div className="slot-fill" role="img" aria-label={`context ${fmtTokens(s.contextTokens)} of ${fmtTokens(max)}`}>
        <div className="slot-fill-head">
          <span className="slot-fill-num">{fmtTokens(s.contextTokens)}</span>
          <span className="muted small">of {fmtTokens(max)} context</span>
        </div>
        <div className="slot-bar"><i className={tone} style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="slot-stats">
        <span className="pill pill-soft" title="Builder runs in this session"><Icon name="robot" size={13} />{s.runs} {s.runs === 1 ? "run" : "runs"}</span>
        <span className="pill pill-soft" title="Times the session was replaced by a fresh one"><Icon name="refresh" size={13} />{s.rotations} fresh</span>
        <span className="pill pill-soft" title={s.lastUsedAt ?? "not used yet"}><Icon name="clock" size={13} />{s.lastUsedAt ? ago(s.lastUsedAt) : "not used yet"}</span>
      </div>

      <div className="slot-actions">
        <button className="ghost sm" onClick={copy} disabled={!s.resumeCommand} title={s.resumeCommand ?? "No session yet: it starts with the first builder run"}>
          <Icon name={copied ? "check" : "terminal"} size={14} />
          {copied ? "Copied" : "Open in Claude"}
        </button>
        <button className="ghost sm" onClick={() => confirm("Start the next builder run in a fresh session?") && act.mutate()} disabled={s.busy || act.isPending || !s.sessionId} title="Next builder run starts a fresh session">
          <Icon name="refresh" size={14} />
          Reset
        </button>
      </div>
      {s.busy && <p className="slot-warn small"><Icon name="alert" size={13} /> An agent is using this session. Copying is fine, but don't type into it until the run ends.</p>}
      <ErrorText error={act.error} />
    </div>
  );
}

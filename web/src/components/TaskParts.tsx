/** Task details and run transcripts, shared by the plan diagram and the runs tab. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtDateTime, fmtDuration, fmtTime, fmtTokens, type Run, type Task } from "../api";
import { Badge, Empty, ErrorText, Expandable, Markdown } from "../ui";
import { Checklist, CommandPipeline } from "./Visual";

export function TaskDetail({ t, canRetry, onRetry, hideFeedback = false }: { t: Task; canRetry: boolean; onRetry: (m: string) => void; hideFeedback?: boolean }) {
  const [note, setNote] = useState("");
  const ver = useQuery({ queryKey: ["verifications", t.id], queryFn: () => api.verifications(t.id) });
  const runs = useQuery({ queryKey: ["runs", { taskId: t.id }], queryFn: () => api.runs({ taskId: t.id }) });
  // Newest result per command (the API lists newest first).
  const latest = new Map<string, { ok: boolean; ms: number; tail?: string }>();
  for (const v of ver.data ?? []) if (!latest.has(v.command)) latest.set(v.command, { ok: v.exitCode === 0, ms: v.durationMs, tail: v.outputTail });
  const lastAt = ver.data?.[0]?.createdAt ?? null;
  return (
    <div className="task-detail-body">
      <h4>Done when</h4>
      <Checklist items={t.acceptance} done={t.status === "done"} />
      <h4>Checks{latest.size > 0 && <span className="muted small"> · last run {fmtTime(lastAt)}</span>}</h4>
      <CommandPipeline commands={t.verifyCommands} results={latest} />
      {t.dependsOnKeys.length > 0 && (
        <>
          <h4>Starts after</h4>
          <div className="key-chips">{t.dependsOnKeys.map((k) => <span key={k} className="key-chip mono">{k}</span>)}</div>
        </>
      )}
      <details className="spec-details" open={!["done", "skipped"].includes(t.status)}>
        <summary>What to do</summary>
        <Markdown text={t.spec} bare />
      </details>
      {t.lastFeedback && !hideFeedback && (
        <>
          <h4>Last feedback</h4>
          <Expandable text={t.lastFeedback} lines={6} />
        </>
      )}
      {runs.data && runs.data.length > 0 && (
        <>
          <h4>Runs</h4>
          <RunList runs={runs.data} compact />
        </>
      )}
      {canRetry && (
        <form className="retry-form" onSubmit={(e) => { e.preventDefault(); onRetry(note); setNote(""); }}>
          <input placeholder="Optional note for the worker" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="ghost">Retry with note</button>
        </form>
      )}
    </div>
  );
}

export function RunList({ runs, compact = false }: { runs: Run[]; compact?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <table className="runs">
      <thead>
        <tr>
          <th>Started</th><th>Kind</th>{!compact && <th>Task</th>}<th>Model</th><th>Duration</th><th>Turns</th><th>Tokens</th><th>Cache read</th><th>Result</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <RunRow key={r.id} r={r} compact={compact} open={openId === r.id} toggle={() => setOpenId(openId === r.id ? null : r.id)} />
        ))}
      </tbody>
    </table>
  );
}

function RunRow({ r, compact, open, toggle }: { r: Run; compact: boolean; open: boolean; toggle: () => void }) {
  const result = !r.endedAt ? "running" : r.errorKind ?? (r.isError ? "error" : "ok");
  const cols = compact ? 8 : 9;
  return (
    <>
      <tr className="run-row" onClick={toggle}>
        <td className="small">{fmtDateTime(r.startedAt)}</td>
        <td>{r.kind.replace("_", " ")}</td>
        {!compact && <td className="mono small">{r.taskKey ?? "—"}</td>}
        <td className="small">{r.model}{r.effort ? `/${r.effort}` : ""}</td>
        <td className="small">{fmtDuration(r.startedAt, r.endedAt)}</td>
        <td className="small">{r.numTurns || "—"}</td>
        <td className="small">{fmtTokens(r.inputTokens + r.outputTokens + r.cacheCreationTokens)}</td>
        <td className="small muted">{fmtTokens(r.cacheReadTokens)}</td>
        <td><Badge value={result === "ok" ? "done" : result === "running" ? "running" : result === "limit" ? "limited" : "failed"}>{result}</Badge></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={cols}><RunLog id={r.id} /></td>
        </tr>
      )}
    </>
  );
}

function RunLog({ id }: { id: string }) {
  const { data, error } = useQuery({ queryKey: ["runLog", id], queryFn: () => api.runLog(id) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading log…</p>;
  if (data.missing) return <Empty>No log file for this run.</Empty>;
  return (
    <div className="runlog">
      {data.entries.map((e, i) => {
        switch (e.kind) {
          case "init":
            return <div key={i} className="log-meta">session {e.sessionId} · {e.model}</div>;
          case "text":
            return <div key={i} className="log-text">{e.text}</div>;
          case "tool":
            return <div key={i} className="log-tool"><span className="tool-name">{e.name}</span> <span className="mono">{e.input}</span></div>;
          case "tool_result":
            return <pre key={i} className={`log-result ${e.isError ? "bad-text" : ""}`}>{e.text}</pre>;
          case "rate_limit":
            return <div key={i} className="log-meta">rate limit: {e.status}{e.utilization != null ? ` · ${Math.round(e.utilization * 100)}%` : ""}</div>;
          case "result":
            return (
              <div key={i} className={`log-final ${e.isError ? "bad" : ""}`}>
                <div className="log-meta">result · {e.turns ?? "?"} turns{e.costUsd != null ? ` · ~$${e.costUsd.toFixed(2)}` : ""}</div>
                <Expandable text={e.text} lines={10} />
              </div>
            );
        }
      })}
      {data.truncated && <p className="muted small">… log truncated</p>}
    </div>
  );
}

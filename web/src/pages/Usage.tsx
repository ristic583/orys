import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtTokens, type UsageRow } from "../api";
import { Empty, ErrorText, Segmented } from "../ui";

const KINDS = ["architect", "mapper", "planner", "worker", "master_review", "probe"] as const;
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];

function sum(rows: UsageRow[], f: (r: UsageRow) => number) {
  return rows.reduce((s, r) => s + f(r), 0);
}

export function UsagePage() {
  const [days, setDays] = useState(7);
  const { data, error } = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(days) });
  if (error) return <ErrorText error={error} />;
  const rows = data?.rows ?? [];
  const projects = [...new Set(rows.map((r) => r.projectSlug))].sort();
  const color = (slug: string) => SERIES[projects.indexOf(slug) % SERIES.length]!;

  // One bar per calendar day in the range, even days without runs.
  const today = new Date();
  const dayKeys = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    return d.toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
  });
  const perDay = dayKeys.map((day) => ({ day, byProject: projects.map((p) => sum(rows.filter((r) => r.day === day && r.projectSlug === p), (r) => r.tokens)) }));
  const max = Math.max(1, ...perDay.map((d) => d.byProject.reduce((a, b) => a + b, 0)));

  return (
    <>
      <div className="hero-head">
        <h1>
          Usage <span className="muted-strong">by project and run kind</span>
        </h1>
        <Segmented label="Range" value={days} onChange={setDays} options={[{ id: 7, label: "Week" }, { id: 14, label: "2 weeks" }, { id: 30, label: "Month" }]} />
      </div>
      <p className="muted small lede">
        Tokens = input + output + cache writes (what counts most against the limit). Cache reads are shown separately. Dollar amounts are the
        CLI's notional API price; on a subscription they are only a relative measure.
      </p>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : !rows.length ? (
        <Empty>No runs in this range.</Empty>
      ) : (
        <>
          <div className="legend">
            {projects.map((p) => (
              <span key={p}><i style={{ background: color(p) }} /> {p}</span>
            ))}
          </div>
          <div className="bars card" role="img" aria-label="tokens per day by project">
            {perDay.map((d) => {
              const total = d.byProject.reduce((a, b) => a + b, 0);
              return (
                <div className="bar-col" key={d.day} title={`${d.day}: ${fmtTokens(total)} tokens`}>
                  <div className="bar-area">
                    <span className="bar-value">{total ? fmtTokens(total) : ""}</span>
                    <div className="bar" style={{ height: `${(total / max) * 100}%` }}>
                      {d.byProject.map((v, i) => v > 0 && <div key={i} style={{ flexGrow: v, background: color(projects[i]!) }} />)}
                    </div>
                  </div>
                  <span className="bar-label">{d.day.slice(5)}</span>
                </div>
              );
            })}
          </div>

          <h2>By project and run kind</h2>
          <div className="card table-card"><table className="usage">
            <thead>
              <tr>
                <th>Project</th>
                {KINDS.map((k) => <th key={k} className="num">{k.replace("_", " ")}</th>)}
                <th className="num">Total</th><th className="num">Cache read</th><th className="num">Runs</th><th className="num">~$</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const pr = rows.filter((r) => r.projectSlug === p);
                return (
                  <tr key={p}>
                    <td>{p}</td>
                    {KINDS.map((k) => {
                      const v = sum(pr.filter((r) => r.kind === k), (r) => r.tokens);
                      return <td key={k} className="num">{v ? fmtTokens(v) : "—"}</td>;
                    })}
                    <td className="num"><strong>{fmtTokens(sum(pr, (r) => r.tokens))}</strong></td>
                    <td className="num muted">{fmtTokens(sum(pr, (r) => r.cacheRead))}</td>
                    <td className="num">{sum(pr, (r) => r.runs)}</td>
                    <td className="num">{sum(pr, (r) => r.cost).toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}

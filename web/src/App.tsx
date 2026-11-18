import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtTime } from "./api";
import { Icon } from "./components/Icon";
import { Brand } from "./components/Logo";
import { elapsed, useNow } from "./hooks";
import { useLiveUpdates } from "./live";
import { NewProject } from "./pages/NewProject";
import { HubPage } from "./pages/Hub";
import { RemoteChip, RemotePage } from "./pages/Remote";
import { Overview } from "./pages/Overview";
import { ProjectPage } from "./pages/Project";
import { SessionsPage } from "./pages/Sessions";
import { UsagePage } from "./pages/Usage";
import { Link, useLocation } from "./router";

export function App() {
  const live = useLiveUpdates();
  const remote = useQuery({ queryKey: ["remote"], queryFn: api.remote, refetchInterval: 10_000 }).data;
  const hubAdmin = !!useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5_000 }).data?.hubAdmin;
  const { path } = useLocation();
  const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
  let page;
  if (path === "/" || path === "") page = <Overview />;
  else if (path === "/new") page = <NewProject />;
  else if (path === "/usage") page = <UsagePage />;
  else if (path === "/sessions") page = <SessionsPage />;
  else if (path === "/remote") page = <RemotePage />;
  else if (path === "/hub" && hubAdmin) page = <HubPage />;
  else if (projectMatch) page = <ProjectPage id={decodeURIComponent(projectMatch[1]!)} />;
  else page = <p className="muted">Page not found. <Link to="/">Back to overview</Link></p>;

  const nav = [
    { to: "/", label: "Overview", match: (p: string) => p === "/" || p.startsWith("/projects") },
    { to: "/sessions", label: "Sessions", match: (p: string) => p === "/sessions" },
    { to: "/usage", label: "Usage", match: (p: string) => p === "/usage" },
    { to: "/new", label: "New project", match: (p: string) => p === "/new" },
    ...(hubAdmin ? [{ to: "/hub", label: "Hub", match: (p: string) => p === "/hub" }] : []),
  ];
  return (
    <div className="shell">
      {import.meta.env.VITE_ORYS_DEMO === "1" && <DemoBanner />}
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Orys home">
          <Brand />
        </Link>
        <nav className="nav">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-pill${n.match(path) ? " active" : ""}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <RemoteChip data={remote} />
          <JobChip />
          <QuotaChip />
          {!live && (
            <span className="round-btn live off" title="Live updates disconnected">
              <i />
            </span>
          )}
        </div>
      </header>
      <main className="page">{page}</main>
    </div>
  );
}

function JobChip() {
  const now = useNow(1000);
  const { data } = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5_000 });
  if (!data) return null;
  const s = data.scheduler;
  if (!s) return <span className="chip muted" title="Started with --no-scheduler">Scheduler off</span>;
  const jobs = s.jobs ?? (s.current ? [{ ...s.current, run: null, activity: null }] : []);
  if (!jobs.length) return <span className="chip muted">Idle</span>;
  const first = jobs[0]!;
  // The timer is the running agent's, not the scheduler step's.
  const since = first.run?.startedAt ?? first.startedAt;
  const title = jobs.map((j) => `${j.slug}: ${j.run ? `${j.run.kind}${j.run.taskKey ? ` ${j.run.taskKey}` : ""}` : j.stage}${j.activity ? ` · ${j.activity}` : ""}`).join("\n");
  return (
    <Link to={jobs.length > 1 ? "/" : `/projects/${first.slug}`} className="chip chip-live" title={title}>
      <i className="pulse-dot" />
      {jobs.length > 1 ? `${jobs.length} projects working` : first.slug}
      {jobs.length === 1 && <span className="mono muted">{elapsed(since, now)}</span>}
    </Link>
  );
}

function QuotaChip() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 10_000 });
  const probe = useMutation({ mutationFn: api.probe, onSettled: () => qc.invalidateQueries() });
  if (!data) return null;
  const l = data.limit;
  const blocked = l.blocked || !!l.authError || l.status === "limited";
  // Quiet when all is well: show the chip only when the quota is hit or a fresh warning says it is close.
  if (!blocked && (l.utilization ?? 0) < 0.9) return null;
  const text = l.authError
    ? "Not logged in"
    : l.blocked
      ? `Quota hit · back ${fmtTime(l.blockedUntil)}`
      : l.utilization != null
        ? `${Math.round(l.utilization * 100)}% quota`
        : "Quota ok";
  const tone = blocked ? "red" : (l.utilization ?? 0) >= 0.9 ? "amber" : "lime";
  return (
    <>
      <span className={`chip tone-${tone}`} title={l.resetAt ? `${l.rateLimitType ?? ""} window resets ${new Date(l.resetAt).toLocaleString()}` : undefined}>
        <i className="dot" />
        {text}
      </span>
      {blocked && (
        <button className="round-btn" onClick={() => probe.mutate()} disabled={probe.isPending || !!data.scheduler?.jobs?.length} title="Check the quota now (one tiny haiku call)">
          <Icon name="refresh" size={16} />
        </button>
      )}
    </>
  );
}

/** Shown only in the static demo build. */
function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <span>
        <b>Demo.</b> Recorded from real Orys runs on three small projects; read-only.
      </span>
      <a href="https://github.com/ristic583/orys" target="_blank" rel="noreferrer">
        Source and setup on GitHub →
      </a>
    </div>
  );
}

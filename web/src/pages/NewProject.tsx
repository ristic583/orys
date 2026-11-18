/**
 * New-project wizard (SPEC §17.1): pick a mode, then answer one question per
 * step. Each mode asks different things and starts a different agent flow.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ago, api, ApiError, PROFILES, type Profile, type ProjectMode, type ReworkKind } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { StackRow } from "../components/Tech";
import { CommandPipeline, IconChip } from "../components/Visual";
import { navigate } from "../router";
import { ErrorText, Segmented } from "../ui";

// ─────────── answers ───────────

type Feature = { title: string; description: string; priority: number };
type Answers = {
  name: string;
  slug: string;
  slugTouched: boolean;
  problem: string;
  features: Feature[];
  constraints: string[];
  aspects: string[];
  repoPath: string;
  /** in_place: ai-pm/* branches in the repo; sandbox: agents work on a copy (test mode). */
  workspace: "in_place" | "sandbox";
  currentState: string;
  nextGoals: string;
  offLimits: string[];
  verifyCommands: string[];
  kinds: ReworkKind[];
  successCriteria: string[];
  behaviorFrozen: boolean;
  scope: string[];
  profile: Profile;
  priority: number;
  deadline: string;
  startNow: boolean;
};

const EMPTY: Answers = {
  name: "", slug: "", slugTouched: false, problem: "", features: [], constraints: [], aspects: [],
  repoPath: "", workspace: "in_place", currentState: "", nextGoals: "", offLimits: [], verifyCommands: [],
  kinds: [], successCriteria: [], behaviorFrozen: true, scope: [],
  profile: "balanced", priority: 3, deadline: "", startNow: true,
};

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// ─────────── modes ───────────

const MODES: { id: ProjectMode; icon: IconName; title: string; text: string; flow: string }[] = [
  { id: "scratch", icon: "spark", title: "Start from scratch", text: "A new idea. Agents design the architecture, plan the work and build it.", flow: "Architect → plan → build" },
  { id: "existing", icon: "arrowUpRight", title: "Continue a project", text: "Code that already exists. Agents map it first, find gaps and propose what to do next.", flow: "Map → you pick → plan → build" },
  { id: "rework", icon: "refresh", title: "Rework & test", text: "An almost finished project to redesign, refactor or cover with tests.", flow: "Map & measure → you confirm → plan → build" },
];

const REWORK_KINDS: { id: ReworkKind; title: string; text: string; criteria: string[] }[] = [
  { id: "redesign_ui", title: "Redesign UI", text: "New look, layout or UX", criteria: ["Consistent design system across pages", "Lighthouse accessibility ≥ 95"] },
  { id: "refactor", title: "Refactor", text: "Cleaner structure, same features", criteria: ["No circular imports", "No module over 400 lines"] },
  { id: "tests", title: "Tests & coverage", text: "Make it safe to change", criteria: ["Line coverage ≥ 80%", "Every bug fix gets a regression test"] },
  { id: "performance", title: "Performance", text: "Faster responses, less load", criteria: ["p95 response time < 200 ms"] },
  { id: "security", title: "Security", text: "Harden inputs, auth, secrets", criteria: ["No high or critical dependency advisories", "All inputs validated at the boundary"] },
  { id: "dependencies", title: "Dependencies", text: "Upgrade and prune packages", criteria: ["No deprecated dependencies", "All dependencies on a supported major version"] },
];

const CONSTRAINT_IDEAS = ["TypeScript", "Node.js 22+", "Python", "SQLite", "PostgreSQL", "No paid services", "Runs locally", "Docker", "Minimal dependencies", "REST API", "Web UI"];
const ASPECT_IDEAS = ["Security", "Tests for everything", "Performance", "Accessibility", "Easy to deploy", "Good docs"];
const PROFILE_TEXT: Record<Profile, string> = {
  quality: "Opus plans, strong workers, review after every task.",
  balanced: "Opus plans, Sonnet builds, review after every task.",
  speed: "Faster models, fewer reviews.",
  cost: "Cheapest models, review per phase only.",
};

type Step = { id: string; label: string; title: ReactNode; hint?: string; valid: (a: Answers, repoOk: boolean) => boolean };

const nameStep: Step = {
  id: "name", label: "Name", title: <>What should we <em>call it?</em></>,
  hint: "The slug becomes the folder and branch-safe id.",
  valid: (a) => !!a.name.trim() && SLUG_RE.test(a.slug),
};
const settingsStep: Step = { id: "settings", label: "Settings", title: <>How should agents <em>spend effort?</em></>, hint: "You can change all of this later.", valid: () => true };
const reviewStep: Step = { id: "review", label: "Review", title: <>Ready to <em>go?</em></>, valid: () => true };
const repoStep: Step = {
  id: "repo", label: "Repository", title: <>Where is the <em>code?</em></>,
  hint: "A local project folder. Choose whether agents work in it (on their own branches) or on a copy that leaves it untouched.",
  valid: (_a, ok) => ok,
};

const STEPS: Record<ProjectMode, Step[]> = {
  scratch: [
    nameStep,
    { id: "problem", label: "Problem", title: <>What should <em>exist</em> when it's done?</>, hint: "Who is it for and what can they do with it? A few sentences are enough.", valid: (a) => a.problem.trim().length >= 10 },
    { id: "features", label: "Features", title: <>Which features <em>matter most?</em></>, hint: "Optional. Priorities guide the order of the plan.", valid: () => true },
    { id: "constraints", label: "Constraints", title: <>Any <em>rules</em> to follow?</>, hint: "Stack, hosting, budget, and what quality means for this project.", valid: () => true },
    settingsStep,
    reviewStep,
  ],
  existing: [
    repoStep,
    { ...nameStep, title: <>What is this <em>project?</em></> },
    { id: "purpose", label: "Purpose", title: <>What does it <em>do?</em></>, hint: "Its purpose and users, as you would explain it to a new teammate.", valid: (a) => a.problem.trim().length >= 10 },
    { id: "state", label: "Where it stands", title: <>Where did you <em>leave off?</em></>, hint: "What works, what is half done, what hurts. The mapper checks this against the code.", valid: (a) => a.currentState.trim().length >= 10 },
    { id: "guardrails", label: "Guardrails", title: <>What must agents <em>respect?</em></>, hint: "Areas not to touch and how to check that nothing broke.", valid: () => true },
    settingsStep,
    reviewStep,
  ],
  rework: [
    repoStep,
    { ...nameStep, title: <>What is this <em>project?</em></> },
    { id: "kinds", label: "Kind of work", title: <>What do you want to <em>improve?</em></>, hint: "Pick one or more.", valid: (a) => a.kinds.length > 0 && a.problem.trim().length >= 10 },
    { id: "success", label: "Success", title: <>How do we know it's <em>done?</em></>, hint: "Measurable targets make the plan and the reviews sharper.", valid: () => true },
    { id: "constraints", label: "Constraints", title: <>Any <em>rules</em> to follow?</>, hint: "Stack decisions to keep, tools to avoid, budget.", valid: () => true },
    settingsStep,
    reviewStep,
  ],
};

// ─────────── wizard ───────────

export function NewProject() {
  const [mode, setMode] = useState<ProjectMode | null>(null);
  const [a, setA] = useState<Answers>(EMPTY);
  const [i, setI] = useState(0);
  const [repo, setRepo] = useState<{ path: string; ok: boolean } | null>(null);
  const set = (patch: Partial<Answers>) => setA((prev) => ({ ...prev, ...patch }));

  if (!mode) return <ModePicker onPick={(m) => { setMode(m); setI(0); }} />;
  const steps = STEPS[mode];
  const step = steps[i]!;
  const repoOk = !!repo?.ok && repo.path === a.repoPath;
  const canNext = step.valid(a, repoOk);
  const next = () => canNext && setI(Math.min(i + 1, steps.length - 1));
  const back = () => (i === 0 ? setMode(null) : setI(i - 1));
  const modeInfo = MODES.find((m) => m.id === mode)!;

  return (
    <div className="wizard">
      <aside className="wz-rail">
        <button className="wz-mode" onClick={() => setMode(null)} title="Change the kind of project">
          <span className="card-icon"><Icon name={modeInfo.icon} /></span>
          <span>
            <span className="muted small">Mode</span>
            <strong>{modeInfo.title}</strong>
          </span>
        </button>
        <ol className="wz-steps">
          {steps.map((s, k) => (
            <li key={s.id} className={k === i ? "current" : k < i ? "done" : ""}>
              <button onClick={() => k < i && setI(k)} disabled={k > i}>
                <span className="wz-num">{k < i ? <Icon name="check" size={13} /> : k + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <p className="muted small wz-flow">{modeInfo.flow}</p>
      </aside>

      <section className="card wz-card">
        <div className="wz-count muted small">Step {i + 1} of {steps.length}</div>
        <h1 className="wz-title">{step.title}</h1>
        {step.hint && <p className="wz-hint">{step.hint}</p>}
        <div className="wz-body" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !(e.target as HTMLElement).dataset.chip && next()}>
          <StepBody id={step.id} mode={mode} a={a} set={set} onRepo={setRepo} />
        </div>
        <div className="wz-foot">
          <button className="ghost" onClick={back}>Back</button>
          {step.id === "review" ? (
            <CreateButton mode={mode} a={a} />
          ) : (
            <button className="primary" onClick={next} disabled={!canNext}>
              Continue <Icon name="arrowUpRight" size={16} className="rot45" />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ModePicker({ onPick }: { onPick: (m: ProjectMode) => void }) {
  return (
    <>
      <div className="hero-head">
        <h1>
          New project, <span className="muted-strong">where are we starting?</span>
        </h1>
      </div>
      <div className="mode-grid">
        {MODES.map((m) => (
          <button key={m.id} className="card mode-card" onClick={() => onPick(m.id)}>
            <span className="mode-icon"><Icon name={m.icon} size={22} /></span>
            <h2>{m.title}</h2>
            <p className="muted">{m.text}</p>
            <span className="mode-flow">{m.flow}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function StepBody({ id, mode, a, set, onRepo }: { id: string; mode: ProjectMode; a: Answers; set: (p: Partial<Answers>) => void; onRepo: (r: { path: string; ok: boolean }) => void }) {
  switch (id) {
    case "repo":
      return <RepoStep a={a} set={set} onRepo={onRepo} />;
    case "name":
      return (
        <div className="row">
          <label>
            Name
            <input autoFocus value={a.name} placeholder="Link shortener" onChange={(e) => set({ name: e.target.value, ...(a.slugTouched ? {} : { slug: slugify(e.target.value) }) })} />
          </label>
          <label>
            Slug
            <input className="mono" value={a.slug} onChange={(e) => set({ slug: e.target.value, slugTouched: true })} aria-invalid={!!a.slug && !SLUG_RE.test(a.slug)} />
          </label>
        </div>
      );
    case "problem":
    case "purpose":
      return (
        <textarea autoFocus rows={6} value={a.problem} onChange={(e) => set({ problem: e.target.value })}
          placeholder={id === "problem" ? "A personal link shortener: paste a long URL, get a short one, see how many times it was opened. Just for me, runs on my machine." : "An online shop for my bakery: customers browse products, order for pickup, I manage stock in an admin page."} />
      );
    case "state":
      return (
        <>
          <label>
            Current state
            <textarea autoFocus rows={4} value={a.currentState} onChange={(e) => set({ currentState: e.target.value })} placeholder="Catalog and cart work. Checkout is half done, no tests for payments, the admin page is a mess." />
          </label>
          <label>
            What should happen next? <span className="hint">optional</span>
            <textarea rows={3} value={a.nextGoals} onChange={(e) => set({ nextGoals: e.target.value })} placeholder="Finish checkout first, then clean up the admin page." />
          </label>
        </>
      );
    case "guardrails":
      return (
        <>
          <label>Don't touch <span className="hint">paths or areas, Enter to add</span></label>
          <ChipInput values={a.offLimits} onChange={(v) => set({ offLimits: v })} placeholder="infra/, payments provider config" />
          <label>How to check nothing broke <span className="hint">commands; leave empty to let the mapper find them</span></label>
          <ChipInput values={a.verifyCommands} onChange={(v) => set({ verifyCommands: v })} placeholder="npm test" mono />
        </>
      );
    case "features":
      return <FeatureList features={a.features} onChange={(features) => set({ features })} />;
    case "constraints":
      return (
        <>
          <label>Constraints <span className="hint">pick or type your own</span></label>
          <ChipInput values={a.constraints} onChange={(v) => set({ constraints: v })} ideas={CONSTRAINT_IDEAS} placeholder="Type and press Enter" />
          {mode === "scratch" && (
            <>
              <label>What matters most for quality</label>
              <ChipInput values={a.aspects} onChange={(v) => set({ aspects: v })} ideas={ASPECT_IDEAS} placeholder="Type and press Enter" />
            </>
          )}
        </>
      );
    case "kinds":
      return (
        <>
          <div className="kind-grid">
            {REWORK_KINDS.map((k) => {
              const on = a.kinds.includes(k.id);
              return (
                <button key={k.id} className={`kind${on ? " on" : ""}`} aria-pressed={on} onClick={() => set({ kinds: on ? a.kinds.filter((x) => x !== k.id) : [...a.kinds, k.id] })}>
                  <span className="kind-check">{on && <Icon name="check" size={14} />}</span>
                  <strong>{k.title}</strong>
                  <span className="muted small">{k.text}</span>
                </button>
              );
            })}
          </div>
          <label>
            In one or two sentences, what is the project?
            <textarea rows={3} value={a.problem} onChange={(e) => set({ problem: e.target.value })} placeholder="A dashboard my team uses to track deliveries. Works, but it's slow and has almost no tests." />
          </label>
        </>
      );
    case "success": {
      const ideas = REWORK_KINDS.filter((k) => a.kinds.includes(k.id)).flatMap((k) => k.criteria);
      return (
        <>
          <label>Targets</label>
          <ChipInput values={a.successCriteria} onChange={(v) => set({ successCriteria: v })} ideas={ideas} placeholder="Type a target and press Enter" />
          <div className="toggle-row">
            <div>
              <strong>Keep behavior as it is</strong>
              <p className="muted small">Public APIs and what users see stay the same. Agents first write tests that pin down current behavior, then change code.</p>
            </div>
            <Segmented label="Keep behavior" value={a.behaviorFrozen ? "yes" : "no"} onChange={(v) => set({ behaviorFrozen: v === "yes" })} options={[{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]} />
          </div>
          <label>Limit to <span className="hint">paths; empty means the whole repository</span></label>
          <ChipInput values={a.scope} onChange={(v) => set({ scope: v })} placeholder="src/admin/" mono />
        </>
      );
    }
    case "settings":
      return (
        <>
          <div className="profile-grid">
            {PROFILES.map((p) => (
              <button key={p} className={`profile-opt${a.profile === p ? " on" : ""}`} onClick={() => set({ profile: p })} aria-pressed={a.profile === p}>
                <strong>{p[0]!.toUpperCase() + p.slice(1)}</strong>
                <span className="muted small">{PROFILE_TEXT[p]}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <label>
              Priority <span className="hint">higher gets more of the shared quota</span>
              <Segmented label="Priority" value={a.priority} onChange={(v) => set({ priority: v })} options={[1, 2, 3, 4, 5].map((n) => ({ id: n, label: String(n) }))} />
            </label>
            <label>
              Deadline <span className="hint">optional</span>
              <input type="date" value={a.deadline} onChange={(e) => set({ deadline: e.target.value })} />
            </label>
          </div>
        </>
      );
    case "review":
      return <Review mode={mode} a={a} set={set} />;
    default:
      return null;
  }
}

// ─────────── repository step ───────────

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A typed value is a path (inspect it) when it starts like one; anything else is a search over the found repos. */
const looksLikePath = (v: string) => /^[~/]/.test(v);

function RepoStep({ a, set, onRepo }: { a: Answers; set: (p: Partial<Answers>) => void; onRepo: (r: { path: string; ok: boolean }) => void }) {
  const raw = a.repoPath.trim();
  const path = useDebounced(looksLikePath(raw) ? raw : "", 450);
  const copy = a.workspace === "sandbox";
  const q = useQuery({ queryKey: ["inspect", path, copy], queryFn: () => api.inspectRepo(path, copy), enabled: path.length > 1, retry: false, staleTime: 0 });
  const r = q.data;
  useEffect(() => {
    if (!r) return;
    onRepo({ path: a.repoPath.trim() === path ? a.repoPath : path, ok: r.problems.length === 0 });
    // Prefill from what was found, without overwriting the owner's edits.
    if (r.problems.length === 0) {
      set({
        ...(a.name ? {} : { name: r.name, slug: a.slugTouched ? a.slug : slugify(r.name) }),
        ...(a.verifyCommands.length ? {} : { verifyCommands: r.suggestedVerify }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);
  return (
    <>
      <RepoPicker value={a.repoPath} onChange={(repoPath) => set({ repoPath })} />
      <div className="workspace-pick">
        <button className={`profile-opt${!copy ? " on" : ""}`} aria-pressed={!copy} onClick={() => set({ workspace: "in_place" })}>
          <span className="ws-icon"><Icon name="branch" size={18} /></span>
          <strong>Work in this repository</strong>
          <span className="muted small">On <code>ai-pm/*</code> branches. Yours changes only on Merge.</span>
        </button>
        <button className={`profile-opt${copy ? " on" : ""}`} aria-pressed={copy} onClick={() => set({ workspace: "sandbox" })}>
          <span className="ws-icon copy"><Icon name="shield" size={18} /></span>
          <strong>Work on a copy · test mode</strong>
          <span className="muted small">A copy in <code>~/aipm-sandbox</code>. Your folder is only read, never changed.</span>
        </button>
      </div>
      {q.isFetching && <p className="muted small">Checking…</p>}
      {r && path && (
        <div className="inspect">
          <Check ok={r.exists} label={r.exists ? r.path : "Folder not found"} />
          {r.exists && <Check ok={r.isGit} label={r.isGit ? `Git repository · ${r.commits} commit${r.commits === 1 ? "" : "s"} · ${r.trackedFiles} files` : "Not a git repository"} />}
          {r.isGit && !copy && <Check ok={!!r.branch && !r.branch.startsWith("ai-pm/")} label={r.branch ? <>Your branch: <code>{r.branch}</code> stays untouched until you merge</> : "Detached HEAD"} />}
          {r.isGit && !copy && <Check ok={r.clean} label={r.clean ? "Working tree is clean" : `${r.dirty.length} uncommitted change${r.dirty.length === 1 ? "" : "s"}`} />}
          {r.exists && copy && <Check ok label={<>Agents work on a copy in <code>~/aipm-sandbox</code>; this folder is only read</>} />}
          {r.lastCommit && <p className="muted small inspect-last">Last commit: “{r.lastCommit.subject}” · {new Date(r.lastCommit.date).toLocaleDateString()}</p>}
          {(r.detected.stacks.length > 0 || r.detected.packageManager) && (
            <div className="inspect-tags">
              <StackRow items={r.detected.stacks} extra={[r.detected.packageManager, r.detected.hasDocker ? "Docker" : null].filter((x): x is string => !!x)} />
              {r.detected.hasTests && <IconChip icon="flask" tone="lime">Tests</IconChip>}
              {r.detected.hasCi && <IconChip icon="gear" tone="lime">CI</IconChip>}
            </div>
          )}
          {r.suggestedVerify.length > 0 && (
            <div className="inspect-tags"><CommandPipeline commands={r.suggestedVerify} /></div>
          )}
          {r.problems.map((p) => <p key={p} className="inspect-problem">{p}</p>)}
          {r.warnings.map((w) => <p key={w} className="muted small">{w}</p>)}
        </div>
      )}
      {q.error && <ErrorText error={q.error} />}
    </>
  );
}

/** Search the git repositories found on this machine, or type a path. */
function RepoPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const qc = useQueryClient();
  const found = useQuery({ queryKey: ["discover"], queryFn: () => api.discoverRepos(), staleTime: 60_000 });
  const rescan = useMutation({ mutationFn: () => api.discoverRepos(true), onSuccess: (d) => qc.setQueryData(["discover"], d) });
  const repos = found.data?.repos ?? [];
  const home = found.data?.roots[0] ?? "";
  const short = (p: string) => (!home ? p : p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const raw = value.trim();
  const picked = repos.find((r) => r.path === raw || short(r.path) === raw);
  const term = raw.toLowerCase();
  const matches = picked
    ? []
    : repos
        .filter((r) => !term || r.name.toLowerCase().includes(term) || short(r.path).toLowerCase().includes(term))
        .sort((x, y) => Number(y.name.toLowerCase().startsWith(term)) - Number(x.name.toLowerCase().startsWith(term)));
  const scanning = found.isFetching || rescan.isPending;
  return (
    <>
      <div className="repo-search">
        <Icon name="folder" size={16} />
        <input autoFocus className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search your repositories, or paste a path" spellCheck={false} />
        {value && <button className="repo-clear" onClick={() => onChange("")} aria-label="Clear"><Icon name="x" size={14} /></button>}
      </div>
      {matches.length > 0 && (
        <div className="repo-list" role="listbox" aria-label="Git repositories on this machine">
          {matches.slice(0, 50).map((r) => (
            <button key={r.path} role="option" aria-selected={false} className="repo-row" onClick={() => onChange(r.path)}>
              <span className="repo-icon"><Icon name="branch" size={15} /></span>
              <span className="repo-text">
                <strong>{r.name}</strong>
                <span className="mono muted small">{short(r.path)}</span>
              </span>
              {r.project && <span className="pill pill-soft" title="Orys already has a project for this folder">in Orys · {r.project}</span>}
              <span className="muted small nowrap">{r.lastActivity ? ago(r.lastActivity) : ""}</span>
            </button>
          ))}
        </div>
      )}
      {!picked && term && !matches.length && !looksLikePath(raw) && !scanning && <p className="muted small">No repository matches “{raw}”. Paste a full path instead.</p>}
      <p className="muted small repo-meta">
        {scanning ? "Looking for git repositories…" : found.data ? `${repos.length} git ${repos.length === 1 ? "repository" : "repositories"} in ${found.data.roots.map(short).join(", ")}${found.data.truncated ? " (search stopped early)" : ""}` : ""}
        {!scanning && <button className="link-btn" onClick={() => rescan.mutate()}><Icon name="refresh" size={12} />Rescan</button>}
      </p>
      <ErrorText error={found.error ?? rescan.error} />
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: ReactNode }) {
  return (
    <div className={`check-line ${ok ? "ok" : "bad"}`}>
      <span className="check-dot">{ok ? <Icon name="check" size={12} /> : "!"}</span>
      <span>{label}</span>
    </div>
  );
}

// ─────────── inputs ───────────

function ChipInput({ values, onChange, ideas = [], placeholder, mono }: { values: string[]; onChange: (v: string[]) => void; ideas?: string[]; placeholder?: string; mono?: boolean }) {
  const [text, setText] = useState("");
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
  };
  const unused = ideas.filter((x) => !values.includes(x));
  return (
    <div className="chips-field">
      <div className="chips">
        {values.map((v) => (
          <span key={v} className={`chip-tag${mono ? " mono" : ""}`}>
            {v}
            <button onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>×</button>
          </span>
        ))}
        <input data-chip="1" className={mono ? "mono" : ""} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => add(text)} placeholder={values.length ? "" : placeholder} />
      </div>
      {unused.length > 0 && (
        <div className="ideas">
          {unused.map((x) => (
            <button key={x} className="idea" onClick={() => add(x)}>+ {x}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function FeatureList({ features, onChange }: { features: Feature[]; onChange: (f: Feature[]) => void }) {
  const upd = (k: number, p: Partial<Feature>) => onChange(features.map((f, j) => (j === k ? { ...f, ...p } : f)));
  return (
    <div className="feature-list">
      {features.map((f, k) => (
        <div className="feature-item" key={k}>
          <input data-chip="1" value={f.title} placeholder="Feature" onChange={(e) => upd(k, { title: e.target.value })} />
          <input data-chip="1" value={f.description} placeholder="Short description (optional)" onChange={(e) => upd(k, { description: e.target.value })} />
          <Segmented label="Priority" value={f.priority} onChange={(v) => upd(k, { priority: v })} options={[1, 2, 3, 4, 5].map((n) => ({ id: n, label: String(n) }))} />
          <button className="round-btn" onClick={() => onChange(features.filter((_, j) => j !== k))} aria-label="Remove feature">
            <Icon name="plus" size={16} className="rot45" />
          </button>
        </div>
      ))}
      <button className="ghost" onClick={() => onChange([...features, { title: "", description: "", priority: 3 }])}>
        <Icon name="plus" size={15} /> Add feature
      </button>
    </div>
  );
}

// ─────────── review & create ───────────

function buildBrief(mode: ProjectMode, a: Answers) {
  const common = {
    mode, slug: a.slug, name: a.name.trim(), problem: a.problem.trim(), constraints: a.constraints, aspects: a.aspects,
    priority: a.priority, profile: a.profile, ...(a.deadline ? { deadline: a.deadline } : {}),
  };
  if (mode === "scratch") return { ...common, features: a.features.filter((f) => f.title.trim()) };
  if (mode === "existing") {
    return { ...common, repoPath: a.repoPath.trim(), workspace: a.workspace, existing: { currentState: a.currentState.trim(), nextGoals: a.nextGoals.trim(), offLimits: a.offLimits, verifyCommands: a.verifyCommands } };
  }
  return { ...common, repoPath: a.repoPath.trim(), workspace: a.workspace, rework: { kinds: a.kinds, successCriteria: a.successCriteria, behaviorFrozen: a.behaviorFrozen, scope: a.scope } };
}

const chipList = (xs: string[], empty: ReactNode = "—", mono = false) =>
  xs.length ? <span className="review-chips">{xs.map((x) => <span key={x} className={`chip-tag${mono ? " mono" : ""}`}>{x}</span>)}</span> : empty;

function Review({ mode, a, set }: { mode: ProjectMode; a: Answers; set: (p: Partial<Answers>) => void }) {
  const rows: [string, ReactNode][] = [
    ["Name", <>{a.name} <span className="muted mono">{a.slug}</span></>],
    ...(mode !== "scratch" ? [["Repository", <span className="mono">{a.repoPath}</span>] as [string, ReactNode], ["Works on", a.workspace === "sandbox" ? "A copy (test mode) — your folder is never touched" : "This repository, on ai-pm/* branches"] as [string, ReactNode]] : []),
    [mode === "scratch" ? "Problem" : "Project", a.problem],
    ...(mode === "existing" ? ([["Where it stands", a.currentState], ["Next", a.nextGoals || "—"], ["Don't touch", chipList(a.offLimits, "—", true)], ["Checks", a.verifyCommands.length ? <CommandPipeline commands={a.verifyCommands} /> : "let the mapper find them"]] as [string, ReactNode][]) : []),
    ...(mode === "rework" ? ([["Work", chipList(a.kinds.map((k) => REWORK_KINDS.find((x) => x.id === k)!.title))], ["Targets", chipList(a.successCriteria)], ["Keep behavior", a.behaviorFrozen ? "Yes" : "No"], ["Scope", chipList(a.scope, "whole repository", true)]] as [string, ReactNode][]) : []),
    ...(mode === "scratch" ? ([["Features", chipList(a.features.filter((f) => f.title).map((f) => `P${f.priority} · ${f.title}`))], ["Quality", chipList(a.aspects)]] as [string, ReactNode][]) : []),
    ["Constraints", chipList(a.constraints)],
    ["Profile", `${a.profile} · priority ${a.priority}${a.deadline ? ` · due ${a.deadline}` : ""}`],
  ];
  const first = mode === "scratch" ? "the architect designs the system" : mode === "existing" ? "the mapper studies the code and proposes what to do" : "the mapper studies and measures the code";
  return (
    <>
      <dl className="review">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <label className="check">
        <input type="checkbox" checked={a.startNow} onChange={(e) => set({ startNow: e.target.checked })} />
        Start right away — {first}.
      </label>
    </>
  );
}

function CreateButton({ mode, a }: { mode: ProjectMode; a: Answers }) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async () => {
      const p = await api.createProject(buildBrief(mode, a));
      if (a.startNow) await api.start(p.id);
      return p;
    },
    onSuccess: (p) => {
      void qc.invalidateQueries();
      navigate(`/projects/${p.slug}`);
    },
  });
  const err = create.error;
  return (
    <div className="wz-create">
      {err && (
        <div className="error">
          {err instanceof ApiError && err.problems.length ? err.problems.map((p) => <div key={p}>{p}</div>) : String((err as Error).message)}
        </div>
      )}
      <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}>
        {create.isPending ? "Creating…" : a.startNow ? "Create and start" : "Create project"}
      </button>
    </div>
  );
}

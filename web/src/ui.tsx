import { marked } from "marked";
import { useMemo, useState, type ReactNode } from "react";

const TONE: Record<string, string> = {
  done: "lime", approve: "lime", ok: "lime", skipped: "muted",
  executing: "violet", sketching: "violet", mapping: "violet", awaiting_owner: "amber", running: "violet", verifying: "violet", reviewing: "violet", active: "violet", architecting: "violet", planning: "violet",
  ready: "neutral", pending: "muted", draft: "muted",
  rework: "amber", interrupted: "amber", warning: "amber", waiting: "amber",
  blocked: "red", failed: "red", escalated: "red", escalate: "red", limited: "red", limit: "red", crash: "red", timeout: "red", parse: "red",
};
export const toneOf = (value: string) => TONE[value] ?? "neutral";

/** Status pill with a colored dot. */
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={`pill tone-${toneOf(value)}`}>
      <i className="dot" />
      {children ?? value}
    </span>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} title={`${done}/${total} tasks`}>
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Markdown({ text, bare = false }: { text: string; bare?: boolean }) {
  // Content comes from the project's own repo (written by our agents) and is shown only to the local owner.
  const html = useMemo(() => marked.parse(text, { async: false }), [text]);
  return <div className={bare ? "markdown md-bare" : "markdown card"} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error">{error instanceof Error ? error.message : String(error)}</p>;
}

/** Text that collapses when long. */
export function Expandable({ text, lines = 4 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > 400;
  return (
    <div className="expandable">
      <pre className={open || !long ? "" : "clamped"} style={{ ["--lines" as string]: lines }}>{text}</pre>
      {long && (
        <button className="text-btn" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Segmented pill control. */
export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} role="tab" aria-selected={o.id === value} className={o.id === value ? "active" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Tabs = <T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) => (
  <Segmented options={tabs} value={value} onChange={onChange} label="Sections" />
);

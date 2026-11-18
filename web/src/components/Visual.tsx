/**
 * Small visual building blocks that replace sentences: command pipelines, checklists,
 * baseline tiles with gauges, effort bars and icon chips. Raw text stays in tooltips.
 */
import { Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type Tone = "lime" | "violet" | "amber" | "red" | "neutral";

export function IconChip({ icon, tone = "neutral", title, children }: { icon: IconName; tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`icon-chip tone-${tone}`} title={title}>
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </span>
  );
}

/** Commands as a left-to-right pipeline; with results, each chip shows pass/fail and time. */
export function CommandPipeline({ commands, results }: { commands: string[]; results?: Map<string, { ok: boolean; ms: number; tail?: string }> }) {
  if (!commands.length) return null;
  return (
    <div className="cmd-pipe">
      {commands.map((c, i) => {
        const r = results?.get(c);
        return (
          <Fragment key={c + i}>
            {i > 0 && <Icon name="arrowRight" size={14} className="cmd-arrow" />}
            <span className={`cmd-chip${r ? (r.ok ? " ok" : " bad") : ""}`} title={r?.tail ? r.tail.split("\n").slice(-8).join("\n") : c}>
              {r ? <Icon name={r.ok ? "check" : "x"} size={13} /> : <Icon name="terminal" size={13} />}
              <span className="mono">{c}</span>
              {r && <span className="cmd-ms">{(r.ms / 1000).toFixed(1)}s</span>}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Acceptance criteria as a checklist; ticked when the task is done. */
export function Checklist({ items, done }: { items: string[]; done: boolean }) {
  return (
    <ul className={`checklist${done ? " done" : ""}`}>
      {items.map((a, i) => (
        <li key={i}>
          <span className="cl-box">{done && <Icon name="check" size={12} />}</span>
          <span>{a}</span>
        </li>
      ))}
    </ul>
  );
}

export function Ring({ pct, label, gate, size = 64 }: { pct: number; label: string; gate?: number | null; size?: number }) {
  const r = 26, c = 2 * Math.PI * r;
  const tone = gate != null && pct < gate ? "var(--red)" : pct >= 80 ? "var(--lime)" : pct >= 50 ? "var(--amber)" : "var(--red)";
  const gateAngle = gate != null ? (gate / 100) * 360 - 90 : null;
  return (
    <div className="ring" title={`${label}: ${pct}%${gate != null ? ` (gate ${gate}%)` : ""}`}>
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={tone} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(c * Math.min(pct, 100)) / 100} ${c}`} transform="rotate(-90 32 32)" />
        {gateAngle != null && (
          <line x1="32" y1="2" x2="32" y2="11" stroke="#fff" strokeWidth="2" transform={`rotate(${gateAngle + 90} 32 32)`} />
        )}
        <text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text)">{Math.round(pct)}</text>
      </svg>
      <span className="ring-label">{label}</span>
    </div>
  );
}

// ─────────── baseline (mapper findings) ───────────

const num = (re: RegExp, s: string) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

const BASE_ICON: Record<string, IconName> = { build: "box", tests: "flask", test: "flask", coverage: "target", lint: "check", typecheck: "check", performance: "bolt", security: "shield" };

/**
 * One tile per baseline fact. Known shapes are drawn (tests passing/failing, coverage gauges,
 * error/warning counts); anything else falls back to the text, shortened.
 */
export function BaselineTiles({ baseline }: { baseline: Record<string, string | null> }) {
  const entries = Object.entries(baseline).filter((e): e is [string, string] => !!e[1]);
  return (
    <div className="base-tiles">
      {entries.map(([k, v]) => (
        <BaselineTile key={k} name={k} text={v} />
      ))}
    </div>
  );
}

function BaselineTile({ name, text }: { name: string; text: string }) {
  const label = name[0]!.toUpperCase() + name.slice(1);
  const icon = BASE_ICON[name.toLowerCase()] ?? "gear";
  // Coverage: "98.23% lines / 96.64% branch / 100% functions (gate: 85%/85% lines/functions)"
  const cov = [...text.replace(/\(.*?\)/g, "").matchAll(/(\d+(?:\.\d+)?)\s*%\s*([a-z]+)/gi)].map((m) => ({ pct: Number(m[1]), what: m[2]!.toLowerCase().replace(/^stmts$/, "statements").replace(/^branches$/, "branch") }));
  const gate = num(/gate[^\d]*(\d+(?:\.\d+)?)\s*%/i, text);
  if (cov.length) {
    return (
      <div className="base-tile wide" title={text}>
        <span className="base-name"><Icon name={icon} size={14} />{label}</span>
        <div className="rings">{cov.slice(0, 4).map((c) => <Ring key={c.what} pct={c.pct} label={c.what} gate={gate} />)}</div>
      </div>
    );
  }
  const passing = num(/(\d+)\s*(?:passing|passed|pass)\b/i, text);
  const failing = num(/(\d+)\s*(?:failing|failed|fail)\b/i, text) ?? 0;
  if (passing != null) {
    return (
      <div className={`base-tile${failing ? " bad" : " ok"}`} title={text}>
        <span className="base-name"><Icon name={icon} size={14} />{label}</span>
        <span className="base-big">{passing}<span className="muted"> passing</span></span>
        <span className={`base-sub ${failing ? "tone-red-text" : ""}`}>{failing ? `${failing} failing` : "0 failing"}</span>
      </div>
    );
  }
  const errors = num(/(\d+)\s*errors?\b/i, text);
  const warnings = num(/(\d+)\s*warnings?\b/i, text);
  const okWord = /^\s*(ok|pass|clean|green|success)/i.test(text);
  if (errors != null || okWord) {
    const ok = (errors ?? 0) === 0;
    return (
      <div className={`base-tile${ok ? " ok" : " bad"}`} title={text}>
        <span className="base-name"><Icon name={icon} size={14} />{label}</span>
        <span className="base-big">{ok ? <Icon name="check" size={26} /> : errors}</span>
        <span className="base-sub">{ok ? "No errors" : `${errors} errors`}{warnings ? ` · ${warnings} warnings` : ""}</span>
      </div>
    );
  }
  const short = text.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return (
    <div className="base-tile" title={text}>
      <span className="base-name"><Icon name={icon} size={14} />{label}</span>
      <span className="base-sub">{short.length > 60 ? `${short.slice(0, 59)}…` : short}</span>
    </div>
  );
}

// ─────────── effort / risk ───────────

const EFFORT_N: Record<string, number> = { S: 1, M: 2, L: 3, low: 1, medium: 2, high: 3 };

export function EffortBars({ effort }: { effort: string }) {
  const n = EFFORT_N[effort] ?? 2;
  return (
    <span className="effort-bars" title={`Effort: ${effort}`} aria-label={`Effort ${effort}`}>
      {[1, 2, 3].map((i) => <i key={i} className={i <= n ? "on" : ""} style={{ height: 4 + i * 3 }} />)}
    </span>
  );
}

export function RiskDot({ risk }: { risk: string }) {
  const tone = risk === "high" ? "red" : risk === "medium" ? "amber" : "lime";
  return (
    <span className={`risk-dot tone-${tone}`} title={`Risk: ${risk}`}>
      <i />
      {risk}
    </span>
  );
}

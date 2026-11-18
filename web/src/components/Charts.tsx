import { useMemo, useState } from "react";
import { fmtTokens } from "../api";

// ─────────── smooth area chart ───────────

export type Series = { label: string; values: number[]; tone: "lime" | "ghost" };

/** Catmull-Rom → cubic Bézier path through the points. */
function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return "";
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Each series is scaled to its own maximum: the chart compares shape over time, the tooltip gives exact values. */
export function AreaChart({ labels, series, height = 200 }: { labels: string[]; series: Series[]; height?: number }) {
  const W = 600;
  const H = height;
  const padY = 16;
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const paths = series.map((s) => {
    const max = Math.max(1, ...s.values);
    const pts = s.values.map((v, i) => [x(i), H - padY - (v / max) * (H - padY * 2)] as [number, number]);
    return { s, pts, line: smoothPath(pts) };
  });
  const main = paths[0];
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round((rel / W) * (n - 1)))));
  };
  const tipLeft = hover == null ? 0 : (x(hover) / W) * 100;

  return (
    <div className="area-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(" and ") + " over time"}>
        <defs>
          <linearGradient id="area-lime" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--lime)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--lime)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {main && main.pts.length > 1 && <path d={`${main.line} L${W},${H} L0,${H} Z`} fill="url(#area-lime)" />}
        {paths.map(({ s, line }) => (
          <path key={s.label} d={line} fill="none" className={`line line-${s.tone}`} vectorEffect="non-scaling-stroke" />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="hover-rule" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hover != null &&
        paths.map(({ s, pts }) => (
          <span key={s.label} className={`chart-dot dot-${s.tone}`} style={{ left: `${tipLeft}%`, top: `${(pts[hover]![1] / H) * 100}%` }} />
        ))}
      {hover != null && (
        <div className="chart-tip" style={{ left: `${tipLeft}%` }}>
          <div className="tip-label">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.label} className="tip-row">
              <i className={`swatch sw-${s.tone}`} />
              {fmtTokens(s.values[hover] ?? 0)} <span className="muted">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="chart-x">
        {labels.map((l, i) => (
          <span key={i} className={n > 10 && i % Math.ceil(n / 7) !== 0 ? "hide" : ""}>{l}</span>
        ))}
      </div>
    </div>
  );
}

// ─────────── activity heatmap ───────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUCKETS = [0, 4, 8, 12, 16, 20];

/** Runs per weekday × 4-hour block. */
export function Heatmap({ times }: { times: Date[] }) {
  const grid = useMemo(() => {
    const g = BUCKETS.map(() => DAYS.map(() => 0));
    for (const t of times) {
      const day = (t.getDay() + 6) % 7;
      const b = Math.floor(t.getHours() / 4);
      g[b]![day]!++;
    }
    return g;
  }, [times]);
  const max = Math.max(1, ...grid.flat());
  const level = (v: number) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  return (
    <div className="heatmap">
      <div className="hm-row hm-head">
        <span />
        {DAYS.map((d) => <span key={d}>{d}</span>)}
      </div>
      {grid.map((row, bi) => (
        <div className="hm-row" key={bi}>
          <span className="hm-hour">{String(BUCKETS[bi]).padStart(2, "0")}:00</span>
          {row.map((v, di) => (
            <span key={di} className={`hm-cell l${level(v)}`} title={`${DAYS[di]} ${BUCKETS[bi]}–${BUCKETS[bi]! + 4}h: ${v} run${v === 1 ? "" : "s"}`} />
          ))}
        </div>
      ))}
      <div className="hm-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`hm-cell l${l}`} />)}
        <span>More</span>
      </div>
    </div>
  );
}

// ─────────── share strip (tokens by run kind) ───────────

export type Share = { label: string; value: number };

/** Columns sized by share; the largest is a solid block, the rest are rows of bars. */
export function ShareStrip({ items, average, from, to }: { items: Share[]; average: string; from: string; to: string }) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  return (
    <div className="share-strip">
      <div className="share-avg">
        <span>{average}</span>
      </div>
      <div className="share-cols">
        {sorted.map((it, i) => {
          const pct = it.value / total;
          return (
            <div key={it.label} className="share-col" style={{ flex: `${Math.max(pct, 0.1)} 1 0` }}>
              <div className="share-value">{fmtTokens(it.value)}</div>
              <div className="share-label">
                <strong>{Math.round(pct * 100)}%</strong> {it.label}
              </div>
              {i === 0 ? (
                <div className="share-block" />
              ) : (
                <div className={`share-bars tone-${Math.min(i, 3)}`}>
                  {Array.from({ length: Math.max(3, Math.round(pct * 60)) }, (_, k) => <i key={k} />)}
                </div>
              )}
            </div>
          );
        })}
        {!sorted.length && <div className="muted">No runs in this range yet.</div>}
      </div>
      <div className="share-dates">
        <span>{from}</span>
        <span>{to}</span>
      </div>
    </div>
  );
}

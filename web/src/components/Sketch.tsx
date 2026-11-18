/**
 * Sketch first (SPEC §22.7): the owner looks at a quick draft within
 * minutes, says what to change, and agrees before anything is planned.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ProjectDetail, type SketchVersion } from "../api";
import { ErrorText } from "../ui";
import { Icon } from "./Icon";

const fileUrl = (projectId: string, v: number, file: string) => `/api/projects/${projectId}/sketch/files/${v}/${file}`;

export function SketchCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sketch", project.id], queryFn: () => api.sketch(project.id), refetchInterval: project.status === "sketching" ? 5_000 : false });
  const [note, setNote] = useState("");
  const [direction, setDirection] = useState<string | null>(null);
  const done = () => { setNote(""); void qc.invalidateQueries(); };
  const revise = useMutation({ mutationFn: (different: boolean) => api.reviseSketch(project.id, { message: note || "Try something clearly different.", different, direction: direction ?? undefined }), onSuccess: done });
  const approve = useMutation({ mutationFn: () => api.approveSketch(project.id, direction ?? undefined), onSuccess: done });
  if (!data || (!data.versions.length && !data.sketching)) return null;
  const current = data.versions.at(-1);
  const earlier = data.versions.slice(0, -1);
  const making = data.sketching ? (current?.status === "revise" || !current ? (current?.version ?? 0) + 1 : null) : null;
  // Only the sketch steps themselves; once agreed, the outcome card on the plan shows it.
  if (!data.waiting && !making) return null;

  return (
    <section className="card sketch-card" aria-labelledby="sketch-title">
      <div className="outcome-head">
        <h2 id="sketch-title">{making ? `Making sketch v${making}…` : `Sketch v${current!.version}`}</h2>
        {current && !making && (
          <span className="pill pill-soft" title={current.scope.reason}>
            Building it properly: {current.scope.size} · {current.scope.risk} risk
          </span>
        )}
      </div>
      {making ? (
        <p className="muted">
          A rough draft to look at, usually ready in 5–15 minutes. Nothing is planned or built properly before you agree on it.
          {current?.feedback && <> Your note: <em>“{current.feedback}”</em></>}
        </p>
      ) : (
        current && <Version projectId={project.id} v={current} existing={project.mode !== "scratch"} direction={direction} onDirection={setDirection} />
      )}

      {data.waiting && current && (
        <div className="sketch-actions">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? e.g. “bigger numbers, temperature on top”" />
          <div className="row">
            <button className="primary" onClick={() => approve.mutate()} disabled={approve.isPending || (current.directions.length > 0 && !direction)} title={current.directions.length && !direction ? "Pick a direction first" : undefined}>
              <Icon name="check" size={16} /> That's it, build it properly
            </button>
            <button className="tool-btn" onClick={() => revise.mutate(false)} disabled={revise.isPending || note.trim().length < 3}>
              <Icon name="refresh" size={14} /> Change it
            </button>
            <button className="tool-btn" onClick={() => revise.mutate(true)} disabled={revise.isPending}>
              <Icon name="spark" size={14} /> Try a different direction
            </button>
          </div>
          {current.directions.length > 0 && !direction && <p className="muted small">Pick a direction above to agree on it, or tell Orys what to change.</p>}
          <ErrorText error={approve.error ?? revise.error} />
        </div>
      )}

      {earlier.length > 0 && (
        <details className="sketch-history">
          <summary className="muted small">Earlier versions ({earlier.length})</summary>
          {earlier.map((v) => (
            <div key={v.version} className="sketch-old">
              <strong>v{v.version}</strong> {v.feedback && <span className="muted">→ you said: “{v.feedback}”</span>}
              <div className="shots">
                {v.screens.slice(0, 4).map((s) => (
                  <a key={s.file} href={fileUrl(project.id, v.version, s.file)} target="_blank" rel="noreferrer"><img src={fileUrl(project.id, v.version, s.file)} alt={s.caption || s.file} loading="lazy" /></a>
                ))}
              </div>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/**
 * What the owner sees today and will no longer see once this is built. The
 * real build follows the sketch, so this is decided here, not discovered at
 * the handoff. Only for existing projects: a new one has nothing to lose.
 */
export function Removals({ items, compact = false }: { items: string[]; compact?: boolean }) {
  if (!items.length) return <p className="sketch-keep muted small"><Icon name="lock" size={13} /> Nothing you see today goes away.</p>;
  return (
    <div className={`sketch-dropped${compact ? " compact" : ""}`} role="note">
      <h3><Icon name="eyeOff" size={15} /> You will no longer see</h3>
      <ul className="outcome-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {!compact && <p className="muted small">Everything else you see today stays. If something here should stay, say so below (“keep …”).</p>}
    </div>
  );
}

function Version({ projectId, v, existing, direction, onDirection }: { projectId: string; v: SketchVersion; existing: boolean; direction: string | null; onDirection: (id: string) => void }) {
  const used = new Set(v.directions.flatMap((d) => d.screens));
  const others = v.directions.length ? v.screens.filter((s) => !used.has(s.file)) : [];
  const dropped = v.no_longer_shown ?? [];
  const anyDropped = dropped.length > 0 || v.directions.some((d) => d.no_longer_shown?.length);
  return (
    <>
      <p className="outcome-summary">{v.summary_plain}</p>
      {others.length > 0 && (
        <div className="sketch-today">
          <h3><Icon name="clock" size={15} /> {others.some((s) => /before|today|current/i.test(s.file)) ? "Today, for comparison" : "Other screens"}</h3>
          <div className="sketch-shots">
            {others.map((s) => (
              <a key={s.file} href={fileUrl(projectId, v.version, s.file)} target="_blank" rel="noreferrer" className={/-375\b|phone|mobile/i.test(s.file) ? "phone" : undefined}>
                <img src={fileUrl(projectId, v.version, s.file)} alt={s.caption || s.file} loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      )}
      {v.directions.length > 0 ? (
        <div className="design-grid" role="radiogroup" aria-label="Directions">
          {v.directions.map((d) => (
            <article key={d.id} className={`design-option${direction === d.id ? " chosen" : ""}`}>
              <a className="design-frame" href={d.screens[0] ? fileUrl(projectId, v.version, d.screens[0]) : undefined} target="_blank" rel="noreferrer" title="Open full size">
                {d.screens[0] && <img src={fileUrl(projectId, v.version, d.screens[0])} alt={`${d.title}`} loading="lazy" />}
                {d.screens[1] && <img className="design-phone" src={fileUrl(projectId, v.version, d.screens[1])} alt={`${d.title}, phone`} loading="lazy" />}
                <span className="design-open"><Icon name="arrowUpRight" size={14} /> Full size</span>
              </a>
              <h4>{d.title} {direction === d.id && <span className="pill pill-soft tone-lime"><i className="dot" />picked</span>}</h4>
              <p className="muted small">{d.idea}</p>
              {existing && !!d.no_longer_shown?.length && (
                <p className="design-drops small"><Icon name="eyeOff" size={13} /> No longer shown: {d.no_longer_shown.join("; ")}</p>
              )}
              <button role="radio" aria-checked={direction === d.id} className={direction === d.id ? "ghost sm" : "primary sm"} onClick={() => onDirection(d.id)}>
                {direction === d.id ? "Picked" : "This one"}
              </button>
            </article>
          ))}
        </div>
      ) : (
        v.screens.length > 0 && (
          <div className="sketch-shots">
            {v.screens.map((s) => (
              <a key={s.file} href={fileUrl(projectId, v.version, s.file)} target="_blank" rel="noreferrer" className={/-375\b|phone|mobile/i.test(s.file) ? "phone" : undefined}>
                <img src={fileUrl(projectId, v.version, s.file)} alt={s.caption || s.file} loading="lazy" />
                {s.caption && <span className="muted small">{s.caption}</span>}
              </a>
            ))}
          </div>
        )
      )}
      {v.demo.map((d, i) => (
        <div key={i} className="sketch-demo">
          <code>$ {d.command}</code>
          <pre>{d.output}</pre>
        </div>
      ))}
      {existing && v.no_longer_shown && (dropped.length > 0 || !anyDropped) && <Removals items={dropped} />}
      <div className="outcome-cols">
        {v.what_is_real.length > 0 && (
          <div>
            <h3><Icon name="check" size={15} /> Real already</h3>
            <ul className="outcome-list">{v.what_is_real.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        )}
        {v.what_is_faked.length > 0 && (
          <div>
            <h3><Icon name="flask" size={15} /> Faked for the sketch (built for real later)</h3>
            <ul className="outcome-list">{v.what_is_faked.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        )}
      </div>
      {v.how_to_run && <p className="muted small"><Icon name="terminal" size={13} /> Try it yourself: <code>{v.how_to_run}</code></p>}
    </>
  );
}

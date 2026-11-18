/**
 * Level 2 for the owner (SPEC §22.5): what you will get before building
 * (outcome card, estimate, design directions to pick from), and what you got
 * at the end (handoff with accept / send back).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtDateTime, type OutcomeView, type ProjectDetail } from "../api";
import { ErrorText } from "../ui";
import { Icon } from "./Icon";
import { Removals } from "./Sketch";

const MODE_LABEL = { quick: "Quick job", standard: "Standard job", full: "Full process" } as const;
const VISIBLE_LABEL = { none: "nothing new on screen", little: "little new on screen", moderate: "visible changes", large: "big visible changes" } as const;

export function useOutcome(projectId: string) {
  return useQuery({ queryKey: ["outcome", projectId], queryFn: () => api.outcome(projectId) });
}

/** "What you will get": shown on the plan tab; editable answers while the plan waits for approval. */
export function OutcomeCard({ project }: { project: ProjectDetail }) {
  const { data } = useOutcome(project.id);
  if (!data?.outcome) return null;
  const o = data.outcome;
  const pending = project.status === "awaiting_owner" && project.ownerGate === "approve_plan";
  return (
    <section className="card outcome-card" aria-labelledby="outcome-title">
      <div className="outcome-head">
        <h2 id="outcome-title">What you will get</h2>
        <div className="outcome-meta">
          {data.process && (
            <span className="pill pill-soft tone-violet" title={`${data.process.scope.reason}\n${data.process.why}`}>
              <i className="dot" />
              {MODE_LABEL[data.process.mode]} · {data.process.scope.size}
            </span>
          )}
          {data.estimate && (
            <span className="pill pill-soft" title={`Done around ${fmtDateTime(data.estimate.doneBy)} if it starts now`}>
              <Icon name="clock" size={13} />
              {data.estimate.text}
            </span>
          )}
        </div>
      </div>
      {data.warnings.map((w) => (
        <p key={w.code} className="outcome-warn" role="status">
          <Icon name="alert" size={15} /> {w.text}
        </p>
      ))}
      <p className="outcome-summary">{o.summary_plain}</p>
      {data.sketch && (
        <div className="sketch-agreed">
          <h3><Icon name="check" size={15} /> The sketch you agreed on (v{data.sketch.version}) — the plan builds this, properly</h3>
          <div className="sketch-shots">
            {data.sketch.screens.map((s) => {
              const url = `/api/projects/${project.id}/sketch/files/${data.sketch!.version}/${s.file}`;
              return (
                <a key={s.file} href={url} target="_blank" rel="noreferrer" className={/-375\b|phone|mobile/i.test(s.file) ? "phone" : undefined}>
                  <img src={url} alt={s.caption || s.file} loading="lazy" />
                </a>
              );
            })}
          </div>
          {data.sketch.noLongerShown && <Removals items={data.sketch.noLongerShown} compact />}
        </div>
      )}
      <div className="outcome-cols">
        <div>
          <h3><Icon name="eye" size={15} /> You will see <span className="muted small">· {VISIBLE_LABEL[o.visible_change]}</span></h3>
          {o.you_will_see.length ? (
            <ul className="outcome-list">
              {o.you_will_see.map((s, i) => <li key={i}><strong>{s.where}:</strong> {s.what}</li>)}
            </ul>
          ) : <p className="muted small">Nothing you can see; the work is under the hood.</p>}
        </div>
        <div>
          <h3><Icon name="lock" size={15} /> Stays the same</h3>
          {o.stays_the_same.length ? <ul className="outcome-list">{o.stays_the_same.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="muted small">—</p>}
          {o.to_see_it.length > 0 && (
            <>
              <h3><Icon name="flag" size={15} /> To see it</h3>
              <ul className="outcome-list">{o.to_see_it.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          )}
        </div>
      </div>
      {data.phases.some((p) => p.goalPlain) && (
        <ol className="outcome-phases">
          {data.phases.map((p) => (
            <li key={p.idx} className={p.status === "done" ? "done" : undefined}>
              <span className="muted small">Phase {p.idx}</span> {p.goalPlain ?? p.title} {p.visible && <Icon name="eye" size={13} className="muted" />}
            </li>
          ))}
        </ol>
      )}
      {data.answers.length > 0 && <Questions projectId={project.id} view={data} editable={pending} />}
      {data.designs && <DesignPicker projectId={project.id} view={data} editable={pending} />}
    </section>
  );
}

function Questions({ projectId, view, editable }: { projectId: string; view: OutcomeView; editable: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: () => api.answer(projectId, draft), onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: ["outcome", projectId] }); } });
  const why = Object.fromEntries((view.outcome?.open_questions ?? []).map((q) => [q.question, q.why_it_matters]));
  return (
    <div className="outcome-questions">
      <h3><Icon name="target" size={15} /> Decided before building {editable && <span className="muted small">· change any answer you disagree with</span>}</h3>
      {view.answers.map((a) => (
        <label key={a.question} className="outcome-q">
          <span>{a.question}{why[a.question] && <span className="muted small"> — {why[a.question]}</span>}</span>
          {editable ? (
            <input value={draft[a.question] ?? a.answer} onChange={(e) => setDraft({ ...draft, [a.question]: e.target.value })} />
          ) : (
            <strong>{a.answer}{a.byOwner ? "" : <span className="muted small"> (proposed)</span>}</strong>
          )}
        </label>
      ))}
      {editable && Object.keys(draft).length > 0 && (
        <button className="primary sm" onClick={() => save.mutate()} disabled={save.isPending}>Save answers</button>
      )}
      <ErrorText error={save.error} />
    </div>
  );
}

/** 2–3 mockups that differ in layout; the owner picks one before building. */
function DesignPicker({ projectId, view, editable }: { projectId: string; view: OutcomeView; editable: boolean }) {
  const qc = useQueryClient();
  const chosen = view.designChoice?.id ?? null;
  const [note, setNote] = useState(view.designChoice?.note ?? "");
  const pick = useMutation({ mutationFn: (id: string) => api.chooseDesign(projectId, id, note), onSuccess: () => void qc.invalidateQueries() });
  const src = (file: string) => `/api/projects/${projectId}/designs/${file}`;
  return (
    <div className="design-picker">
      <h3><Icon name="grid" size={15} /> {editable && !chosen ? "Pick a design direction" : "Design direction"}</h3>
      {editable && !chosen && <p className="muted small">The look is still open, so here are different directions. Workers build the one you pick; nothing is built before that.</p>}
      <div className="design-grid">
        {view.designs!.directions.map((d) => (
          <article key={d.id} className={`design-option${chosen === d.id ? " chosen" : ""}`}>
            <a className="design-frame" href={src(d.file)} target="_blank" rel="noreferrer" title="Open the mockup full size">
              {d.preview ? <img src={src(d.preview)} alt={`${d.title}, desktop`} loading="lazy" /> : <span className="muted small">Open the mockup</span>}
              {d.previewPhone && <img className="design-phone" src={src(d.previewPhone)} alt={`${d.title}, phone`} loading="lazy" />}
              <span className="design-open"><Icon name="arrowUpRight" size={14} /> Full size</span>
            </a>
            <h4>{d.title} {chosen === d.id && <span className="pill pill-soft tone-lime"><i className="dot" />chosen</span>}</h4>
            <p className="muted small">{d.idea}</p>
            {editable && (
              <button className={chosen === d.id ? "ghost sm" : "primary sm"} onClick={() => pick.mutate(d.id)} disabled={pick.isPending}>
                {chosen === d.id ? "Update note" : "Choose this one"}
              </button>
            )}
          </article>
        ))}
      </div>
      {editable && <textarea className="design-note" rows={2} placeholder="Anything to change in the direction you pick? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />}
      {!editable && view.designChoice?.note && <p className="small">Your note: {view.designChoice.note}</p>}
      <ErrorText error={pick.error} />
    </div>
  );
}

const STATUS_ICON = { done: "check", partial: "alert", missing: "x" } as const;

/** The finished result: what was promised vs delivered, how to see it, accept or send back. */
export function HandoffCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const { data } = useOutcome(project.id);
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const done = () => void qc.invalidateQueries();
  const accept = useMutation({ mutationFn: () => api.acceptHandoff(project.id), onSuccess: done });
  const ret = useMutation({ mutationFn: () => api.returnHandoff(project.id, note), onSuccess: () => { setBack(false); setNote(""); done(); } });
  const h = data?.handoff;
  if (!h) return null;
  const verdict = data.accepted;
  return (
    <section className={`card handoff-card${verdict === null ? " pending" : ""}`} aria-labelledby="handoff-title">
      <div className="outcome-head">
        <h2 id="handoff-title">{verdict === true ? "Accepted" : "Your result is ready"}</h2>
        {data.promiseAccuracy !== null && <span className="pill pill-soft">{Math.round(data.promiseAccuracy * 100)}% of promises fully delivered</span>}
      </div>
      <p className="outcome-summary">{h.summary_plain}</p>
      {h.delivered.length > 0 && (
        <ul className="delivered">
          {h.delivered.map((d, i) => (
            <li key={i} className={`dl-${d.status}`}>
              <Icon name={STATUS_ICON[d.status]} size={15} />
              <span>{d.promise}{d.note && <span className="muted small"> — {d.note}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      {h.how_to_see.length > 0 && (
        <>
          <h3><Icon name="eye" size={15} /> How to see it</h3>
          <ul className="outcome-list">{h.how_to_see.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {h.known_gaps.length > 0 && (
        <>
          <h3><Icon name="alert" size={15} /> Good to know</h3>
          <ul className="outcome-list">{h.known_gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {!!h.screenshots?.length && (
        <div className="shots">
          {h.screenshots.map((f) => (
            <a key={f} href={`/api/projects/${project.id}/screens/${f}`} target="_blank" rel="noreferrer" title={f}>
              <img src={`/api/projects/${project.id}/screens/${f}`} alt={f.replace(/\.png$/, "").replace(/-/g, " ")} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {verdict === null && project.status === "done" && (
        <div className="handoff-actions">
          {back ? (
            <form onSubmit={(e) => { e.preventDefault(); ret.mutate(); }}>
              <textarea rows={3} autoFocus placeholder="What is wrong or missing? The agents fix exactly this." value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <button className="primary sm" type="submit" disabled={ret.isPending || note.trim().length < 5}>Send back</button>
                <button className="ghost sm" type="button" onClick={() => setBack(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <button className="primary" onClick={() => accept.mutate()} disabled={accept.isPending}><Icon name="check" size={16} /> Accept</button>
              <button className="tool-btn" onClick={() => setBack(true)}><Icon name="refresh" size={14} /> Send back</button>
            </>
          )}
          <ErrorText error={accept.error ?? ret.error} />
        </div>
      )}
    </section>
  );
}

/** Level-2 metrics (SPEC §22.1) for the overview. */
export function OwnerMetricsStrip() {
  const { data } = useQuery({ queryKey: ["metrics"], queryFn: api.metrics });
  if (!data || (!data.handedOver && data.firstSketchMinutes == null)) return null;
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  return (
    <div className="metrics-strip" aria-label="How well Orys delivers">
      <div><span className="metric-num">{pct(data.acceptedFirstTimeRate)}</span><span className="muted small">accepted without changes ({data.acceptedFirstTime} of {data.judged})</span></div>
      <div><span className="metric-num">{pct(data.promiseAccuracy)}</span><span className="muted small">of promises delivered in full</span></div>
      <div><span className="metric-num">{data.ownerDecisionsPerProject === null ? "—" : data.ownerDecisionsPerProject.toFixed(1)}</span><span className="muted small">decisions you made per project</span></div>
      {data.firstSketchMinutes != null && <div><span className="metric-num">{Math.round(data.firstSketchMinutes)} min</span><span className="muted small">to the first sketch (median; goal ≤ 10)</span></div>}
    </div>
  );
}

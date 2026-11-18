/**
 * Owner gate after mapping (SPEC §17.2): the mapper's findings and proposals;
 * the owner picks what to do (and, for a rework, confirms the targets).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ProjectDetail, type Proposal } from "../api";
import { ErrorText } from "../ui";
import { Icon, type IconName } from "./Icon";
import { StackRow } from "./Tech";
import { BaselineTiles, CommandPipeline, EffortBars, RiskDot } from "./Visual";

const CATEGORY_LABEL: Record<string, string> = {
  feature: "Feature", fix: "Fix", tests: "Tests", refactor: "Refactor", ui: "UI", performance: "Performance",
  security: "Security", dependencies: "Dependencies", infra: "Infra", docs: "Docs",
};
const CATEGORY_ICON: Record<string, IconName> = {
  feature: "spark", fix: "bug", tests: "flask", refactor: "layers", ui: "eye", performance: "bolt",
  security: "shield", dependencies: "box", infra: "gear", docs: "file",
};

export function OwnerChoice({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["map", p.id], queryFn: () => api.map(p.id) });
  const map = data?.map ?? null;
  const [picked, setPicked] = useState<string[] | null>(null);
  const [notes, setNotes] = useState("");
  const [criteria, setCriteria] = useState<string[] | null>(null);
  const [newCriterion, setNewCriterion] = useState("");
  const choose = useMutation({
    mutationFn: () => api.choose(p.id, { picked: chosen, notes, ...(p.mode === "rework" ? { successCriteria: targets } : {}) }),
    onSuccess: () => void qc.invalidateQueries(),
  });

  if (error) return <ErrorText error={error} />;
  if (!map) return <p className="muted">Loading the map…</p>;
  const chosen = picked ?? map.proposals.filter((x) => x.recommended).map((x) => x.id);
  const targets = criteria ?? p.modeDetails?.rework?.successCriteria ?? [];
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const baseline = Object.entries(map.baseline).filter(([, v]) => v);
  const rework = p.mode === "rework";

  return (
    <section className="choice">
      <div className="choice-head">
        <div>
          <div className="graph-kicker">{rework ? "Confirm the goal" : "Decide what's next"}</div>
          <h2>The mapper studied the code. {rework ? "Confirm what to improve." : "Pick what to do first."}</h2>
          <p className="muted choice-summary">{map.summary}</p>
        </div>
      </div>

      {map.stack.length > 0 && <StackRow items={map.stack} />}
      <BaselineTiles baseline={map.baseline} />
      {map.verify_commands.length > 0 && (
        <div className="choice-gate">
          <span className="muted small">Gate</span>
          <CommandPipeline commands={map.verify_commands} />
        </div>
      )}

      {(map.gaps.length > 0 || map.risks.length > 0) && (
        <details className="choice-gaps">
          <summary>
            <span className="icon-chip tone-amber"><Icon name="target" size={14} />{map.gaps.length} gaps</span>
            <span className="icon-chip tone-red"><Icon name="alert" size={14} />{map.risks.length} risks</span>
            <span className="muted small">Show</span>
          </summary>
          <ul className="finding-list">
            {map.gaps.map((g, i) => <li key={`g${i}`}><Icon name="target" size={14} className="tone-amber-text" />{g}</li>)}
            {map.risks.map((g, i) => <li key={`r${i}`}><Icon name="alert" size={14} className="tone-red-text" />{g}</li>)}
          </ul>
        </details>
      )}

      <div className="proposal-grid">
        {map.proposals.map((x) => (
          <ProposalCard key={x.id} x={x} on={chosen.includes(x.id)} toggle={() => toggle(x.id)} />
        ))}
      </div>

      {rework && (
        <div className="choice-block">
          <h3>Success criteria</h3>
          <div className="chips">
            {targets.map((c) => (
              <span key={c} className="chip-tag">
                {c}
                <button onClick={() => setCriteria(targets.filter((x) => x !== c))} aria-label={`Remove ${c}`}>×</button>
              </span>
            ))}
            <input
              value={newCriterion}
              placeholder={targets.length ? "" : "Add a measurable target and press Enter"}
              onChange={(e) => setNewCriterion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCriterion.trim()) {
                  setCriteria([...targets, newCriterion.trim()]);
                  setNewCriterion("");
                }
              }}
            />
          </div>
        </div>
      )}

      <div className="choice-block">
        <h3>Notes for the planner <span className="muted small">optional</span></h3>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Order, scope limits, anything the proposals miss." />
      </div>

      <div className="choice-foot">
        <span className="muted">
          {chosen.length} of {map.proposals.length} selected
        </span>
        <ErrorText error={choose.error} />
        <button className="primary" disabled={choose.isPending || (!chosen.length && !notes.trim())} onClick={() => choose.mutate()}>
          {choose.isPending ? "Sending…" : `Plan ${chosen.length ? `${chosen.length} item${chosen.length > 1 ? "s" : ""}` : "from notes"}`}
          <Icon name="arrowUpRight" size={16} />
        </button>
      </div>
    </section>
  );
}

function ProposalCard({ x, on, toggle }: { x: Proposal; on: boolean; toggle: () => void }) {
  return (
    <button className={`proposal${on ? " on" : ""}`} onClick={toggle} aria-pressed={on}>
      <span className="proposal-top">
        <span className="proposal-cat" title={CATEGORY_LABEL[x.category] ?? x.category}><Icon name={CATEGORY_ICON[x.category] ?? "spark"} size={16} /></span>
        <span className="mono proposal-id">{x.id}</span>
        <span className="muted small">{CATEGORY_LABEL[x.category] ?? x.category}</span>
        {x.recommended && <span className="proposal-rec">Recommended</span>}
        <span className="kind-check">{on && <Icon name="check" size={14} />}</span>
      </span>
      <strong className="proposal-title">{x.title}</strong>
      <span className="muted small proposal-why">{x.why}</span>
      <span className="proposal-meta">
        <EffortBars effort={x.effort} />
        <RiskDot risk={x.risk} />
      </span>
    </button>
  );
}

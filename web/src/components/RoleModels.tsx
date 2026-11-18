/** Model and effort per role (SPEC §17.3): profile defaults, overridable per project. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, EFFORTS, MODELS, ROLES, type Effort, type ModelName, type ProjectDetail, type Role } from "../api";
import { ErrorText } from "../ui";

const ROLE_TEXT: Record<Role, { label: string; hint: string }> = {
  mapper: { label: "Mapper", hint: "Studies an existing repo" },
  architect: { label: "Architect", hint: "Designs a new project" },
  planner: { label: "Planner", hint: "Writes phases and tasks" },
  worker: { label: "Worker", hint: "Implements each task" },
  reviewer: { label: "Reviewer", hint: "Approves or sends back" },
};

export function RoleModels({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (roleModels: Parameters<typeof api.patchProject>[1]["roleModels"]) => api.patchProject(p.id, { roleModels }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["project", p.id] }),
  });
  const roles = p.effectiveRoles;
  if (!roles) return null;
  const roleList = ROLES.filter((r) => (p.mode === "scratch" ? r !== "mapper" : r !== "architect"));
  return (
    <div className="card role-models">
      <div className="role-models-head">
        <h3>Models per role</h3>
        <span className="muted small">Defaults come from the {p.profile} profile. A model you set on a single task wins over these.</span>
      </div>
      <div className="role-grid">
        {roleList.map((r) => {
          const cur = roles[r];
          const own = cur.source === "project";
          const set = (model: ModelName, effort: Effort) => save.mutate({ [r]: { model, effort } });
          return (
            <div key={r} className={`role${own ? " own" : ""}`}>
              <div className="role-name">
                <strong>{ROLE_TEXT[r].label}</strong>
                <span className="muted small">{ROLE_TEXT[r].hint}</span>
              </div>
              <div className="role-pick">
                <select aria-label={`${ROLE_TEXT[r].label} model`} value={cur.model} disabled={save.isPending} onChange={(e) => set(e.target.value as ModelName, cur.effort)}>
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <select aria-label={`${ROLE_TEXT[r].label} effort`} value={cur.effort} disabled={save.isPending} onChange={(e) => set(cur.model, e.target.value as Effort)}>
                  {EFFORTS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="role-source">
                {own ? (
                  <>
                    <span className="pill tone-violet"><i className="dot" />Set for this project</span>
                    <button className="text-btn" disabled={save.isPending} onClick={() => save.mutate({ [r]: null })}>Use default</button>
                  </>
                ) : (
                  <span className="pill pill-soft"><i className="dot" />Profile default</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}

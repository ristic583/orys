/** Typed fetch helpers for the Orys API (shapes mirror src/server/queries.ts). */

export type ProjectStatus = "draft" | "sketching" | "mapping" | "architecting" | "awaiting_owner" | "planning" | "executing" | "blocked" | "done";
export type ProjectMode = "scratch" | "existing" | "rework";
export type ReworkKind = "redesign_ui" | "refactor" | "tests" | "performance" | "security" | "dependencies";
export type TaskStatus =
  | "pending" | "ready" | "running" | "verifying" | "reviewing" | "rework" | "interrupted" | "escalated" | "failed" | "skipped" | "done";
export type Profile = "quality" | "balanced" | "speed" | "cost";
export const PROFILES: Profile[] = ["quality", "balanced", "speed", "cost"];

export type Project = {
  id: string;
  slug: string;
  name: string;
  problem: string;
  aspects: string[];
  constraints: string[];
  priority: number;
  profile: Profile;
  deadline: string | null;
  repoPath: string;
  status: ProjectStatus;
  mode: ProjectMode;
  baseBranch: string | null;
  integrationBranch: string;
  /** sandbox = test mode: agents work on a copy; `sourcePath` is the untouched original. */
  workspace: "in_place" | "sandbox";
  sourcePath: string | null;
  ownerGate: "pick_proposals" | "confirm_goal" | "approve_sketch" | "approve_plan" | null;
  /** Sketch-first flow (SPEC §22.7). */
  sketch?: boolean;
  modeDetails?: {
    existing?: { currentState: string; nextGoals: string; offLimits: string[]; verifyCommands: string[] };
    rework?: { kinds: ReworkKind[]; successCriteria: string[]; behaviorFrozen: boolean; scope: string[] };
  };
  blockedFrom: ProjectStatus | null;
  blockedReason: string | null;
  paused: boolean;
  createdAt: string;
};

export type ProjectSummary = Project & {
  tasksTotal: number;
  tasksDone: number;
  tasksStuck: number;
  /** Every task's status in plan order (phase, then task). */
  taskStates: TaskStatus[];
  phasesTotal: number;
  currentPhase: { idx: number; title: string; status: string } | null;
  tokens7d: number;
  cost7d: number;
  lastRunAt: string | null;
};

export type Role = "mapper" | "architect" | "planner" | "worker" | "reviewer";
export const ROLES: Role[] = ["mapper", "architect", "planner", "worker", "reviewer"];
export type ModelName = "haiku" | "sonnet" | "opus";
export const MODELS: ModelName[] = ["haiku", "sonnet", "opus"];
export type Effort = "low" | "medium" | "high";
export const EFFORTS: Effort[] = ["low", "medium", "high"];
export type ModelChoice = { model: ModelName; effort: Effort };

export type Feature = { id: string; title: string; description: string; priority: number; deadline: string | null; status: string };
/** A project's long-lived Claude session (SPEC §17.7): its builder runs continue it. One per project, no pool. */
export type SessionSlot = {
  id: string;
  idx: number;
  projectId: string | null;
  sessionId: string | null;
  contextTokens: number;
  runs: number;
  rotations: number;
  assignedAt: string | null;
  lastUsedAt: string | null;
  /** `cd <repo> && claude --resume <id>`; null until the first builder run. */
  resumeCommand: string | null;
};
export type SessionOverviewSlot = SessionSlot & { projectSlug: string | null; projectName: string | null; busy: boolean };
export type SessionsOverview = { maxContext: number; slots: SessionOverviewSlot[] };

export type ProjectDetail = Project & {
  features: Feature[];
  session?: SessionSlot | null;
  /** Model and effort each role will use: the profile default unless the project overrides it (M10). */
  effectiveRoles?: Record<Role, ModelChoice & { source: "profile" | "project" }>;
};

export type Task = {
  id: string;
  key: string;
  title: string;
  spec: string;
  acceptance: string[];
  verifyCommands: string[];
  dependsOnKeys: string[];
  model: string | null;
  effort: string | null;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  lastFeedback: string | null;
  runs: number;
  tokens: number;
  /** M10 plan editor: present once the API supports editing. */
  editable?: boolean;
  lockedReason?: "running" | "in_review" | "done" | "skipped" | "in_progress" | null;
  review?: TaskReview;
  modelSource?: "planner" | "owner";
};
export type TaskReview = "default" | "always" | "never";
export type Phase = {
  id: string;
  idx: number;
  title: string;
  goal: string;
  /** "After this phase you can …" (plans made since level 2). */
  goalPlain?: string | null;
  visible?: boolean;
  status: string;
  branch: string;
  tasks: Task[];
  editable?: boolean;
  deletable?: boolean;
  canAddTasks?: boolean;
  lockedReason?: "phase_started" | "phase_done" | null;
};

/** Fields the owner can set on a task. `dependsOn` holds task ids; `model: null` goes back to the planner/profile choice. */
export type TaskEdit = Partial<{
  title: string;
  spec: string;
  acceptance: string[];
  verifyCommands: string[];
  dependsOn: string[];
  model: ModelName | null;
  effort: Effort;
  review: TaskReview;
}>;
export type NewTask = { title: string; spec: string; acceptance: string[]; verifyCommands: string[] } & Omit<TaskEdit, "title" | "spec" | "acceptance" | "verifyCommands"> & { key?: string };
/** A validation problem the plan editor can point at. */
export type PlanProblem = { message: string; taskKey?: string; phaseIdx?: number; field?: "title" | "spec" | "acceptance" | "verifyCommands" | "dependsOn" | "key" };

export type Decision = {
  id: string;
  target: "architecture" | "plan" | "task" | "phase";
  kind: "approve" | "rework" | "escalate";
  rationale: string;
  feedback: string;
  createdAt: string;
  taskKey: string | null;
  phaseIdx: number | null;
  by: "reviewer" | "owner";
};

export type Run = {
  id: string;
  kind: string;
  model: string;
  effort: string | null;
  startedAt: string;
  endedAt: string | null;
  errorKind: string | null;
  isError: boolean | null;
  resultText: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  taskKey: string | null;
  projectSlug: string | null;
};

export type LogEntry =
  | { kind: "init"; model: string | null; sessionId: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "tool_result"; text: string; isError: boolean }
  | { kind: "rate_limit"; status: string; utilization: number | null; resetsAt: number | null }
  | { kind: "result"; text: string; isError: boolean; costUsd: number | null; turns: number | null };

export type Verification = { id: string; command: string; exitCode: number; durationMs: number; outputTail: string; createdAt: string };
export type EventRow = { id: string; type: string; payload: Record<string, unknown>; createdAt: string; projectSlug?: string | null };
export type UsageRow = { day: string; projectSlug: string; kind: string; runs: number; tokens: number; cacheRead: number; cost: number };

export type Status = {
  /** This computer manages an Orys hub: the Hub page is on. */
  hubAdmin?: boolean;
  limit: {
    status: "ok" | "warning" | "limited";
    rateLimitType: string | null;
    utilization: number | null;
    resetAt: string | null;
    authError: string | null;
    lastProbeAt: string | null;
    blocked: boolean;
    blockedReason: string | null;
    blockedUntil: string | null;
  };
  scheduler: null | {
    running: boolean;
    current: { projectId: string; slug: string; stage: string; startedAt: string } | null;
    /** Every project an agent is working on right now (projects run in parallel). */
    jobs?: Job[];
    queue: { slug: string; score: number; weight: number; urgency: number; share: number; locality: boolean }[];
  };
};

/** One project's running step, with the claude run it is in and what that run is doing. */
export type Job = {
  projectId: string;
  slug: string;
  stage: string;
  startedAt: string;
  run: { id: string; kind: string; model: string; startedAt: string; taskKey: string | null; taskTitle: string | null } | null;
  /** Last tool call or line of text of the running agent, e.g. "Edit Dashboard.tsx". */
  activity: string | null;
};

// ─────────── level 2: outcome card, design directions, handoff ───────────

export type OutcomeItem = { where: string; what: string };
export type Outcome = {
  summary_plain: string;
  you_will_see: OutcomeItem[];
  stays_the_same: string[];
  visible_change: "none" | "little" | "moderate" | "large";
  to_see_it: string[];
  open_questions: { question: string; proposed_answer: string; why_it_matters: string }[];
  overview?: string;
};
export type ProcessChoice = {
  mode: "quick" | "standard" | "full";
  scope: { size: string; risk: string; ui: boolean; design_directions?: boolean; reason: string };
  reviewPerTask: boolean;
  maxAttempts: number;
  maxPhases: number;
  planReview: boolean;
  designDirections: boolean;
  why: string;
};
export type DesignDirection = { id: string; title: string; idea: string; file: string; preview?: string | null; previewPhone?: string | null };
export type Handoff = {
  summary_plain: string;
  delivered: { promise: string; status: "done" | "partial" | "missing"; note: string }[];
  how_to_see: string[];
  known_gaps: string[];
  screenshots?: string[];
  at?: string;
};
export type OutcomeView = {
  outcome: Outcome | null;
  answers: { question: string; answer: string; byOwner: boolean }[];
  process: ProcessChoice | null;
  warnings: { code: string; text: string }[];
  estimate: { agentMinutes: number; doneBy: string; limitPauses: number; text: string } | null;
  phases: { idx: number; title: string; goalPlain: string | null; visible: boolean; status: string }[];
  designs: { directions: DesignDirection[] } | null;
  designChoice: { id: string; title: string; file: string; note: string } | null;
  /** `noLongerShown`: null for a new project (nothing exists yet), else what the owner agreed goes away. */
  sketch: { version: number; dir: string; direction: string | null; screens: { file: string; caption: string }[]; noLongerShown?: string[] | null } | null;
  handoff: Handoff | null;
  accepted: boolean | null;
  returns: number;
  promiseAccuracy: number | null;
};
export type SketchVersion = {
  version: number;
  status: "ready" | "revise" | "approved" | "skipped";
  feedback: string | null;
  direction: string | null;
  createdAt: string;
  dir: string;
  summary_plain: string;
  screens: { file: string; caption: string }[];
  demo: { command: string; output: string }[];
  what_is_real: string[];
  what_is_faked: string[];
  how_to_run: string;
  scope: { size: string; risk: string; ui: boolean; reason: string };
  /** What the owner sees today that this sketch leaves out on purpose. */
  no_longer_shown?: string[];
  directions: { id: string; title: string; idea: string; screens: string[]; no_longer_shown?: string[] }[];
};
export type SketchView = { versions: SketchVersion[]; waiting: boolean; sketching: boolean };

export type OwnerMetrics = {
  handedOver: number;
  judged: number;
  acceptedFirstTime: number;
  acceptedFirstTimeRate: number | null;
  promiseAccuracy: number | null;
  ownerDecisions: number;
  ownerDecisionsPerProject: number | null;
  firstSketchMinutes?: number | null;
};

/** Priority 1–5 in words: 5 is the most important (so "P1" is not read as top priority). */
export const PRIORITY_LABEL: Record<number, string> = { 1: "Lowest", 2: "Low", 3: "Normal", 4: "High", 5: "Highest" };

/** Statuses in which a project would be running if the quota allowed it. */
export const RUNNABLE_STATUSES = ["sketching", "mapping", "architecting", "planning", "executing"];

/** A git repository found on this machine (wizard picker). */
export type FoundRepo = { path: string; name: string; lastActivity: string | null; project: string | null };

export type RepoInspection = {
  path: string;
  name: string;
  exists: boolean;
  isGit: boolean;
  branch: string | null;
  clean: boolean;
  dirty: string[];
  commits: number;
  lastCommit: { subject: string; date: string } | null;
  remotes: string[];
  trackedFiles: number;
  detected: { stacks: string[]; packageManager: string | null; scripts: Record<string, string>; hasTests: boolean; hasCi: boolean; hasDocker: boolean };
  suggestedVerify: string[];
  problems: string[];
  warnings: string[];
};

/** What deleting a project would remove (shown before the owner confirms). */
export type DeletionPreview = {
  slug: string;
  name: string;
  orysFolder: { path: string; kind: "sandbox" | "scratch" } | null;
  ownerRepo: string | null;
  runs: number;
};

/** Remote access through the hosted dashboard (SPEC §18). */
export type RemoteView =
  | { available: false; via: "local" | "remote" }
  | {
      available: true;
      via: "local" | "remote";
      configured: boolean;
      enabled: boolean;
      state: "not_configured" | "off" | "connecting" | "connected";
      since: number | null;
      lastError: string | null;
      relayHost: string | null;
      serviceToken: boolean;
      hub: boolean;
    };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public problems: string[] = [],
    /** Structured problems (plan editor 422s); empty when the server sent plain strings. */
    public planProblems: PlanProblem[] = [],
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const issues = (data?.issues as { path: string[]; message: string }[] | undefined)?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    const raw = (data?.problems as (string | PlanProblem)[] | undefined) ?? [];
    const planProblems = raw.filter((p): p is PlanProblem => typeof p === "object" && p !== null);
    throw new ApiError(res.status, issues || data?.error || res.statusText, raw.map((p) => (typeof p === "string" ? p : p.message)), planProblems);
  }
  return data as T;
}

export const api = {
  projects: () => request<ProjectSummary[]>("GET", "/api/projects"),
  project: (id: string) => request<ProjectDetail>("GET", `/api/projects/${id}`),
  createProject: (brief: unknown) => request<Project>("POST", "/api/projects", brief),
  patchProject: (
    id: string,
    patch: Partial<{ priority: number; profile: Profile; deadline: string | null; paused: boolean; roleModels: Partial<Record<Role, ModelChoice | null>> }>,
  ) =>
    request<Project>("PATCH", `/api/projects/${id}`, patch),
  start: (id: string) => request<Project>("POST", `/api/projects/${id}/start`, {}),
  unblock: (id: string, message: string) => request<Project>("POST", `/api/projects/${id}/unblock`, { message }),
  phases: (id: string) => request<Phase[]>("GET", `/api/projects/${id}/phases`),
  decisions: (id: string) => request<Decision[]>("GET", `/api/projects/${id}/decisions`),
  allEvents: (limit = 40) => request<EventRow[]>("GET", `/api/events?limit=${limit}`),
  events: (id: string) => request<EventRow[]>("GET", `/api/projects/${id}/events`),
  doc: (id: string, name: "architecture" | "plan" | "state" | "goals") => request<{ content: string | null; path: string }>("GET", `/api/projects/${id}/docs/${name}`),
  retryTask: (id: string, message?: string) => request<unknown>("POST", `/api/tasks/${id}/retry`, { message }),
  skipTask: (id: string, message?: string) => request<unknown>("POST", `/api/tasks/${id}/skip`, { message }),
  verifications: (taskId: string) => request<Verification[]>("GET", `/api/tasks/${taskId}/verifications`),
  runs: (q: { projectId?: string; taskId?: string; limit?: number }) =>
    request<Run[]>(
      "GET",
      `/api/runs?${new URLSearchParams({ ...(q.projectId ? { project_id: q.projectId } : {}), ...(q.taskId ? { task_id: q.taskId } : {}), ...(q.limit ? { limit: String(q.limit) } : {}) })}`,
    ),
  runLog: (id: string) => request<{ run: Run; entries: LogEntry[]; truncated: boolean; missing: boolean }>("GET", `/api/runs/${id}/log`),
  usage: (days: number) => request<{ days: number; rows: UsageRow[] }>("GET", `/api/usage?range=${days}d`),
  status: () => request<Status>("GET", "/api/status"),
  remote: () => request<RemoteView>("GET", "/api/remote"),
  // The Orys hub, for its owner (SPEC §18.5).
  hub: () => request<HubOverview>("GET", "/api/hub-admin"),
  hubInvite: (note: string) => request<{ url: string; expiresAt: number }>("POST", "/api/hub-admin/invite", { note }),
  hubCancelInvite: (id: number) => request<{ ok: boolean }>("POST", `/api/hub-admin/invites/${id}/cancel`, {}),
  hubSetUser: (login: string, disabled: boolean) => request<{ ok: boolean }>("POST", `/api/hub-admin/users/${encodeURIComponent(login)}/${disabled ? "disable" : "enable"}`, {}),
  hubRevokeDevice: (id: number) => request<{ ok: boolean }>("POST", `/api/hub-admin/devices/${id}/revoke`, {}),
  setRemote: (on: boolean) => request<RemoteView>("POST", `/api/remote/${on ? "enable" : "disable"}`, {}),
  discoverRepos: (refresh = false) =>
    request<{ repos: FoundRepo[]; truncated: boolean; roots: string[] }>("GET", `/api/repo/discover${refresh ? "?refresh=1" : ""}`),
  inspectRepo: (path: string, copy = false) => request<RepoInspection>("POST", "/api/repo/inspect", { path, copy }),
  mergeBase: (id: string) => request<{ merged: boolean; into: string; commits: number }>("POST", `/api/projects/${id}/merge-base`, {}),
  map: (id: string) => request<{ map: RepoMap | null; markdown: string | null }>("GET", `/api/projects/${id}/map`),
  choose: (id: string, body: { picked: string[]; notes: string; successCriteria?: string[] }) => request<Project>("POST", `/api/projects/${id}/choose`, body),
  probe: () => request<{ ok: boolean; reason?: string }>("POST", "/api/probe", {}),
  // Plan editor (M10). Every edit validates the whole plan and returns it.
  editTask: (id: string, edit: TaskEdit) => request<Phase[]>("PATCH", `/api/tasks/${id}`, edit),
  addTask: (phaseId: string, task: NewTask) => request<Phase[]>("POST", `/api/phases/${phaseId}/tasks`, task),
  deleteTask: (id: string) => request<Phase[]>("DELETE", `/api/tasks/${id}`),
  deletionPreview: (id: string) => request<DeletionPreview>("GET", `/api/projects/${id}/deletion`),
  deleteProject: (id: string, confirm: string, removeFolder: boolean) =>
    request<{ deleted: string; removedFolder: string | null; removedLogs: number }>("DELETE", `/api/projects/${id}`, { confirm, removeFolder }),
  moveTask: (id: string, phaseId: string, idx: number) => request<Phase[]>("POST", `/api/tasks/${id}/move`, { phaseId, idx }),
  addPhase: (projectId: string, body: { title: string; goal: string; firstTask: NewTask }) => request<Phase[]>("POST", `/api/projects/${projectId}/phases`, body),
  editPhase: (id: string, edit: { title?: string; goal?: string }) => request<Phase[]>("PATCH", `/api/phases/${id}`, edit),
  deletePhase: (id: string) => request<Phase[]>("DELETE", `/api/phases/${id}`),
  approvePlan: (projectId: string) => request<Project>("POST", `/api/projects/${projectId}/approve-plan`, {}),
  // Session slots (§17.7).
  sessions: () => request<SessionsOverview>("GET", "/api/sessions"),
  outcome: (projectId: string) => request<OutcomeView>("GET", `/api/projects/${projectId}/outcome`),
  answer: (projectId: string, answers: Record<string, string>) => request<OutcomeView>("POST", `/api/projects/${projectId}/outcome/answers`, { answers }),
  chooseDesign: (projectId: string, id: string, note: string) => request<OutcomeView>("POST", `/api/projects/${projectId}/design-choice`, { id, note }),
  acceptHandoff: (projectId: string) => request<Project>("POST", `/api/projects/${projectId}/handoff/accept`, {}),
  returnHandoff: (projectId: string, message: string) => request<Project>("POST", `/api/projects/${projectId}/handoff/return`, { message }),
  metrics: () => request<OwnerMetrics>("GET", "/api/metrics"),
  sketch: (projectId: string) => request<SketchView>("GET", `/api/projects/${projectId}/sketch`),
  reviseSketch: (projectId: string, body: { message: string; different?: boolean; direction?: string }) => request<SketchView>("POST", `/api/projects/${projectId}/sketch/revise`, body),
  approveSketch: (projectId: string, direction?: string) => request<SketchView>("POST", `/api/projects/${projectId}/sketch/approve`, { direction }),
  resetSession: (projectId: string) => request<SessionSlot | null>("POST", `/api/projects/${projectId}/session/reset`, {}),
};

// ─────────── formatting ───────────

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
export const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "—");
export const fmtDateTime = (s: string | null) => (s ? new Date(s).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
export function fmtDuration(a: string, b: string | null): string {
  if (!b) return "running…";
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
/** The Orys hub as its owner sees it (src/hub/server.ts `overview`). Times are epoch ms on the hub's clock. */
export type HubUser = { id: number; login: string; disabled: boolean; createdAt: number };
export type HubDevice = { id: number; userId: number; login: string; name: string; createdAt: number; lastSeenAt: number | null; lastIp: string | null; revoked: boolean };
export type HubInvite = { id: number; note: string; createdAt: number; expiresAt: number; usedBy: string | null; usedAt: number | null };
export type HubEvent = { at: number; userId: number | null; kind: string; detail: unknown };
export type HubOverview = { hubUrl: string; via: string; now: number; users: HubUser[]; devices: HubDevice[]; invites: HubInvite[]; audit: HubEvent[] };

export function ago(s: string | null): string {
  if (!s) return "never";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export type Proposal = {
  id: string;
  title: string;
  why: string;
  category: string;
  effort: "S" | "M" | "L";
  risk: "low" | "medium" | "high";
  recommended: boolean;
};

/** The mapper's structured view of an existing repository. */
export type RepoMap = {
  summary: string;
  stack: string[];
  commands: Record<string, string | null>;
  verify_commands: string[];
  baseline: Record<string, string | null>;
  gaps: string[];
  risks: string[];
  proposals: Proposal[];
  open_questions: { question: string; blocking: boolean; assumption?: string }[];
};

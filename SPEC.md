# Orys: specification

> The design Orys is built from. Section numbers are stable: code comments refer to them as `SPEC §n`.
> Written from the working specification (November 2026); operational notes about where the hosted parts run are left out.

## 1. What Orys is

A local orchestrator that takes a software project from a description of the problem to implemented, verified code, with Claude Code sessions (`claude -p`) as its workers. The owner describes the project (problem, what matters, constraints, features with priority and deadline, an optimisation profile) and Orys runs three loops:

1. **Loop 1, architecture:** a strong model works out the project: stack, architecture, external services, risks.
2. **Loop 2, planning:** the work is split into phases and concrete tasks, each with acceptance criteria and verification commands.
3. **Loop 3, execution:** a worker implements a task, the master code runs the checks, and a master Claude session approves the result or sends it back.

Orys tracks usage itself, notices when the subscription's limit is reached, waits for it to reset and continues exactly where it stopped.

### MVP decisions

| Area | Decision |
|---|---|
| Stack | TypeScript / Node 22, SQLite |
| Dashboard | Local web app (localhost) |
| Workers | Headless `claude -p` on a Claude subscription |
| Approvals | A master Claude session approves the next step; the owner can pause or override from the dashboard |
| "Done" | The task's verify commands (test/build/lint) pass, run by the master code, not by the worker |
| Parallelism | Projects run in parallel and independently; one step at a time inside a project |

## 2. Principles

1. **Master = code + an LLM when needed.** Scheduling, state, checks, limits and usage are deterministic TypeScript. Claude is called only for decisions (architecture, planning, review). A master call is *stateless*: it gets a compact snapshot of the state every time instead of dragging along an ever-growing session.
2. **State lives in the database and in files, never only in a session.** Every project has `docs/ARCHITECTURE.md`, `docs/PLAN.md` and `docs/STATE.md` in its own repository, so any worker can start from nothing and continue.
3. **Verification is not a matter of opinion.** A task passes only if every `verify_commands` entry exits with 0. The worker's report is information, not a verdict.
4. **Everything resumes.** Any interruption (limit, crash, restart) leaves a task in a state it continues from without manual help.
5. **Usage is measured, not estimated.** Every `claude -p` call is recorded with the token counts from its JSON output.

## 3. Stack

| Layer | Choice |
|---|---|
| Runtime | Node ≥ 22, TypeScript (strict), ESM, `tsx` |
| Package manager | pnpm |
| Database | SQLite through `better-sqlite3` + Drizzle ORM (migrations in the repository) |
| Validation | zod (everything that comes from an LLM is validated) |
| Processes | `execa` |
| API | Fastify + server-sent events for live updates |
| Dashboard | Vite + React + TanStack Query, plain CSS |
| CLI | `commander` (`orys …`) |
| Tests | vitest |
| Git | the system `git` through `execa` |

```
src/
  core/        domain: states, types, profiles, outcome rules
  db/          Drizzle schema, migrations, data access
  claude/      Claude CLI client, JSON output parsing, limit detection
  runner/      Runner interface + LocalRunner
  loops/       sketch, mapper, architect, planner, worker, review, handoff
  scheduler/   per-project loops, limit wait and probe
  projects/    briefs, repositories, sandbox copies, plan editor, owner decisions
  sessions/    one long-lived Claude session per project
  server/      Fastify API + SSE
  relay/       remote access: relay, agent, pairing, route policy
  hub/         multi-user hub (§18.5)
  cli/         orys commands
prompts/       prompt templates (.md with {{placeholders}})
web/           Vite React dashboard
```

Projects that Orys builds live outside this repository, in `~/aipm-projects/<slug>/` (`AIPM_PROJECTS_DIR`).

## 4. Data model

Every table has `id` (text, ULID), `created_at`, `updated_at`.

- **projects:** slug, name, problem, aspects[], constraints[], priority 1–5, profile (`quality | balanced | speed | cost`), deadline, runner (`local`), repo_path, worker_permission_mode (default `bypassPermissions`), status (§5.1), blocked_from / blocked_reason, paused, mode (§17), base and integration branch, owner gate, sketch flag, role model overrides.
- **features:** what the owner asked for, with priority and deadline; input to loops 1 and 2.
- **phases:** project, index, title, goal, status (§5.2), branch `phase/<idx>-<slug>`, optional phase-level verify commands.
- **tasks:** phase, feature, index, title, spec, acceptance[], verify_commands[], depends_on[], model, effort, status (§5.3), attempts / max_attempts, session_id, last_feedback, base_sha.
- **runs:** every `claude -p` call: kind (sketch, mapper, architect, planner, worker, master_review, handoff, probe), model, effort, session, timing, exit code, error kind (`limit | auth | crash | timeout | parse`), result text, notional cost, input/output/cache tokens, turns, context size, log path.
- **verifications:** task, run, command, exit code, duration, output tail, baseline flag (§7.3).
- **decisions:** target (architecture, plan, task, phase), kind (approve, rework, escalate), rationale, feedback; owner answers are decisions without a run.
- **limit_state** (one row): status (`ok | warning | limited`), limit type, utilisation, reset time, source text, last probe, auth error.
- **events:** project, type, payload: the feed for the dashboard and the audit trail.
- **sketches, session_slots:** §22.7 and §17.7.

## 5. State machines

Pure functions in `src/core/stateMachines.ts`, covered by tests.

### 5.1 Project

```
draft → (sketching) → architecting | mapping → planning → executing → done
                              ↘          ↘          ↘
                         awaiting_owner (a gate: approve_sketch, pick_proposals, confirm_goal, approve_plan)
                                        blocked (escalation or repeated failure)
```

`paused` is a flag, not a state: the scheduler skips paused projects.

### 5.2 Phase

`pending → active → reviewing → done` (or `blocked`). A phase becomes active when the previous one is done; when all its tasks are done it is reviewed as a whole (§7.5), merged and closed.

### 5.3 Task

```
pending ──(dependencies done)──▶ ready ──▶ running ──▶ verifying
                                  ▲  ▲                    │
                                  │  └── interrupted ◀────┤ (limit or crash while running)
                                  │                       ▼
                               rework ◀── fail ── verify result
                                  ▲                       │ pass
                                  └── rework ◀── reviewing (master)
                                                          │ approve
                                                          ▼
                                                        done
   attempts ≥ max_attempts or escalate ──▶ failed / escalated (project → blocked)
```

- A resumed task (`rework`/`interrupted`) continues its worker session with `--resume`.
- `running → interrupted` when the run ends with a limit or the process disappears; this does not use an attempt. A worker crash or timeout does.
- On start-up, `running` tasks become `interrupted`; `verifying` and `reviewing` simply repeat their step.
- The owner's answer to an escalated or failed task sends it back to `rework` with the answer as feedback and a fresh attempt budget. `skipped` counts as done for dependencies.

## 6. Runner and the Claude client

### 6.1 Runner

```ts
interface Runner {
  ensureWorkspace(project: Project): Promise<void>;                          // folder + git init
  exec(project: Project, cmd: string, opts: ExecOpts): Promise<ExecResult>;  // verify commands, git
  runClaude(project: Project, req: ClaudeRequest): Promise<ClaudeResult>;
}
```

`LocalRunner` runs everything on this computer with the project's repository as working directory. A Docker or remote runner implements the same interface. `recordClaudeRun()` (`src/runs/recorder.ts`) is the **only** way the rest of the application calls Claude: it writes the run before and after the call, updates the limit state and appends a `run_finished` event, in one transaction. `FakeClaudeClient` replays scripted answers, including limits, so loops and the scheduler are tested without spending tokens.

### 6.2 Calling Claude

```
claude -p <prompt via stdin>
  --output-format stream-json --verbose
  --model <model> --effort <effort>
  --permission-mode <mode>
  --strict-mcp-config --setting-sources project,local
  [--resume <session_id>] [--append-system-prompt <role prompt>] [--disallowedTools …]
```

Findings from the first probe of the CLI, which shaped the design:

- `--resume <id>` keeps the context. Every new session carries a fixed overhead of about 28k tokens (system prompt and tools), cached for an hour, so many tiny calls are expensive and resuming within the hour is cheap.
- `--strict-mcp-config --setting-sources project,local` isolates workers from the user's global MCP servers, hooks and settings. `--bare` cannot be used: it does not read the OAuth login, so it does not work with a subscription.
- `--disallowedTools Edit Write NotebookEdit Bash` reliably prevents changes: reviewers and the planner run read-only.
- An error is not an exit code: an authentication failure returns a valid result with `is_error: true`. Only `is_error` is trusted.
- Every `stream-json` run carries `rate_limit_event` messages with the current utilisation, so the dashboard can show it without extra calls.

Timeouts per kind of run (45 minutes for workers, 15 for the rest). The whole stream is stored per run and parsed incrementally for the live view. An `auth` error pauses the scheduler globally and shows a banner; it never uses a task attempt. Workers run with `bypassPermissions` inside their own project (configurable per project) and never get Orys's environment variables; `git push` is always disallowed.

### 6.3 Limit detection

The primary source is the structured event in the stream:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1794787200,"rateLimitType":"seven_day","utilization":0.36}}
```

`rejected` makes the run a `limit` with a reset time; no text parsing is needed. Without an event, an error text that matches known limit messages is classified as a limit with a fallback time. When a limit is hit: the limit state becomes `limited`, the current task is `interrupted`, nothing starts before the reset, and after it the cheapest possible probe (haiku, no tools) checks whether work is accepted again.

## 7. Loops and prompts

Prompt templates are in `prompts/*.md`. Every machine-read answer ends with a JSON block between `<<<JSON` and `JSON>>>`, parsed and validated with zod; an invalid answer gets one correction in the same session, then counts as a failed attempt.

### 7.1 Loop 1: architect

Input: the brief. Writes only `docs/ARCHITECTURE.md` (summary, stack, architecture, layout, data model, API, external services, test strategy with exact verify commands, security, risks, open questions). Returns stack, external services, verify commands, risks and open questions as JSON. Then a master review: `rework` resumes the architect with feedback, a blocking open question escalates to the owner.

### 7.2 Loop 2: planner

Input: the brief and the architecture (or the map, §17). The planner is read-only and returns the plan as JSON; the master code validates it and writes `plan.json`, `PLAN.md` and the first `STATE.md`.

```ts
const PlanSchema = z.object({
  phases: z.array(z.object({
    title: z.string(), goal: z.string(),
    verify_commands: z.array(z.string()).optional(),        // slow, full checks for the phase gate
    tasks: z.array(z.object({
      key: z.string(), title: z.string(), spec: z.string(),
      acceptance: z.array(z.string()).min(1),
      verify_commands: z.array(z.string()).min(1),
      depends_on: z.array(z.string()),
      feature: z.string().optional(),
      model: z.enum(["haiku", "sonnet", "opus"]),
      effort: z.enum(["low", "medium", "high"]),
    })).min(1),
  })).min(1),
});
```

Validation: unique keys, dependencies exist and point to the same or an earlier phase, no cycles, no interactive or dangerous verify commands (`--watch`, dev servers, `git push`, `sudo`). Planning rules: as few phases as possible, the first phase makes the verify commands runnable, every task fits in one worker session.

**Resuming planning:** each step derives its position from the database and the repository, so an interrupted review never pays for the author's run again. Attempts per planning stage are counted since the owner's last answer.

### 7.3 Loop 3: worker

Before a run the master code puts the repository on the phase branch with a clean tree. The worker implements only its task, runs the verify commands itself, updates `STATE.md` and commits `task(<key>): <title>`; anything left uncommitted is committed by the master code so the diff is measurable. A task's review sees `base_sha..HEAD`, all attempts together. Non-blocking reviewer notes go into every later worker prompt.

Lessons built in from real runs:

- **Failures that existed before the task:** when a verify command fails, it is re-run on the task's base commit. If it fails there too, the task goes to review with both outputs instead of burning an attempt; the reviewer decides.
- **Test discipline:** workers run targeted tests while iterating and the full verify commands once at the end; the prompt lists the project's slow commands.
- **Phase-level checks:** slow, full suites run only at the phase gate.
- **UI tasks:** the worker takes headless-browser screenshots (phone and desktop width), looks at them and fixes what it sees; reviews get the screenshots too.

### 7.4 Master review

One template, four targets: architecture, plan, task, phase. Input: the brief, `STATE.md`, the subject (document, plan, or diff with lockfiles and generated files reduced to stats), verify results, acceptance criteria and earlier decisions. Read-only. Output: `approve | rework | escalate` with rationale and feedback.

### 7.5 Finishing a phase

1. **Phase gate:** all verify commands of the phase run again at the tip of the phase branch. A failure creates a fix task.
2. **Phase review** of the whole diff. Approve merges the phase (`--no-ff`) and activates the next one; rework adds a fix task; escalate blocks.
3. The last phase done means the project is done. The main (or integration) branch only moves through phase merges.

## 8. Optimisation profiles

| | quality | balanced | speed | cost |
|---|---|---|---|---|
| Architect | opus/high | opus/high | opus/medium | sonnet/high |
| Planner | opus/high | opus/medium | sonnet/medium | sonnet/medium |
| Worker | sonnet/high (opus if planned) | sonnet/medium | sonnet/low | sonnet/low (haiku if planned) |
| Review | opus/medium | sonnet/high | sonnet/medium | sonnet/low |
| Review per task | risky tasks | risky tasks | no (phase only) | no (phase only) |
| max_attempts | 4 | 3 | 2 | 2 |

The planner proposes a model per task; the profile bounds it. The table is configuration in `src/core/profiles.ts`.

## 9. Scheduler

Projects run in parallel and independently: every runnable project gets its own loop that advances it one step at a time, so a slow project never holds up another. The subscription limit stays global: the main loop waits it out and probes (one probe at a time), and project loops do not start a step while it is blocked. `AIPM_MAX_PARALLEL` optionally caps the number of projects running at once; then a score picks them:

```
score = weight(priority) × urgency(deadline) / (1 + share of tokens used in the last 7 days)
weight(p) = 2^(p-1);  urgency grows from 1 to 4 over the last 14 days before the deadline
```

with a bonus for the project that ran most recently while its prompt cache is still warm. Pausing a project aborts its running call at once (task → `interrupted`, no attempt used). The session id is stored as soon as a run starts, so even a hard kill resumes the same session; on start-up unfinished runs are closed and running tasks interrupted.

## 10. API and dashboard

Fastify on `127.0.0.1:4317`, serving the built dashboard. Main routes: projects (list, create, read, patch, start, unblock, delete), phases and tasks (read, retry, skip, edit, move), decisions, events, documents, verifications, runs and run logs, usage, status, sessions, sketches and outcomes, and `GET /api/events/stream` (SSE: every new event row and job change). Errors: zod → 400, illegal transition → 409, unknown entity → 404, invalid plan edit → 422 with structured problems.

Pages: **Overview** (projects with status, progress and usage; limit and current work), **New project** (a wizard, §17.1), **Project** (stages, sketch, plan editor, runs with live transcripts, decisions, documents), **Sessions**, **Usage**, **Remote** (§18).

## 11. CLI

```
orys serve [--no-scheduler] [--agent] [--keep-awake]   # API + scheduler + dashboard
orys work [--until-idle]                                # scheduler in the foreground
orys project new -f brief.yaml | list | start | run [-n N] | approve | merge | answer | pause | resume | set
orys sessions | session <slug> <action> | probe | status
orys agent [action] [--hub <url>]                       # remote access (§18)
```

## 12. Configuration

Environment: `AIPM_PROJECTS_DIR`, `AIPM_SANDBOX_DIR`, `AIPM_PORT`, `AIPM_DB`, `AIPM_RUNS_DIR`, `AIPM_DEFAULT_PROFILE`, `AIPM_MAX_PARALLEL`, `AIPM_SESSION_MAX_CONTEXT`, `AIPM_REPO_ROOTS`, `AIPM_SKETCH_FIRST`, `AIPM_SUMMARY_LANGUAGE`, timeouts per kind of run (`src/config.ts`).

## 13. Implementation plan

Every milestone ended with a green `pnpm test && pnpm build`.

| M | Content |
|---|---|
| M0 | Probe of the Claude CLI: output format, resume, models, permissions, tools; fixtures recorded |
| M1 | Skeleton: pnpm, TypeScript, vitest, Drizzle schema and migrations, state machines as pure functions |
| M2 | Claude client, LocalRunner, run recording, limit detection |
| M3 | Prompt templates, JSON extraction, architect and planner loops, plan validation |
| M4 | Worker loop, git branches and commits, verify runner, master review, merges |
| M5 | Scheduler, fair share, limit wait and probe, recovery after restart |
| M6 | API, SSE and dashboard |
| M7 | Pilot: a small new project through the whole flow |
| M8–M10 | Project modes and wizard, mapper, plan editor and approval gate (§17) |

## 14. Pilot project

**Links**: a small URL shortener API (Node/TypeScript, SQLite, a handful of endpoints, tests) with a minimal HTML page ([`examples/links.yaml`](../examples/links.yaml)). Small enough to run through within a few limit windows, real enough to have phases and dependencies.

## 15. Open questions

1. A real `rejected` limit event has still to be captured as a fixture.
2. Further tool restrictions for workers beyond `git push` (network commands, deletion outside the repository); the real answer is the Docker runner.
3. The best size limit for review diffs before they are cut to a file list and a sample.

## 16. Pilot log

- **Architecture and planning** of the Links pilot ran without help in about 11 minutes (architect, review, planner, review), about 184k new and 78k cached tokens.
- **First task** passed on its first attempt; the lockfile had eaten the whole review diff budget, so lockfiles and generated files are now reduced to stats in review diffs.
- **The whole pilot** finished without any manual code change in about 1.5 hours (about 45 minutes of agent work): 5 phases, 13 of 13 tasks on the first attempt, 121 tests, 98% coverage, verified from a clean clone. 36 runs, about 1.26M new and 12.3M cached tokens.
- **A real restart** in the middle of a task behaved like a hard kill and recovered into the same session. It revealed that the Claude CLI signals its whole process group, so `claude` now runs in its own group.
- **Reviews cost more than the work** (589k against 567k tokens) and asked for no rework, which led to reviewing only risky tasks and whole phases (§8).

## 17. Project modes, wizard and plan editor

| Mode | For | First agent |
|---|---|---|
| `scratch` | a new idea, an empty repository | architect (or sketch, §22.7) |
| `existing` | code that should be continued | mapper |
| `rework` | an almost finished project to be redesigned, refactored, tested, sped up, secured or upgraded | mapper (baseline first) |

### 17.1 Wizard

One question per step, with examples and defaults: name, problem, features with priority and deadline, constraints, what matters for quality, profile; for existing code the repository path (checked: git, clean tree), where it stands, what is next, areas not to touch and how it is verified; for rework the kinds of work, success criteria, whether behaviour is frozen and the scope. A review screen ends with "Create and start".

### 17.2 Agent flows

```
scratch : (sketch →) architect → review → planner → review → [owner: plan] → execution
existing: mapper → review → [owner: picks proposals] → planner → review → [owner: plan] → execution
rework  : mapper (baseline) → review → [owner: confirms the goal] → planner (rework) → review → [owner: plan] → execution
```

The **mapper** is read-only apart from builds and tests in a sandbox branch; it maps structure, stack, CI, commands, test state and coverage, and returns gaps, risks and **proposals**. Anything it changes outside `.aipm/` is reverted. For rework with frozen behaviour the planner writes characterisation tests before changing code.

### 17.3 Plan editor

Phases and tasks can be added, edited, moved and deleted on a diagram. Models and effort default per role from the profile, can be overridden per project and per task, and review per task can be forced on or off. Every edit validates the whole plan in one transaction and is recorded as an owner event. Before the start everything can change; during execution only pending and ready tasks and phases that have not started.

### 17.4 Working in an existing repository

Agents work in place on branches (`ai-pm/phase-<n>-<slug>`, integration branch `ai-pm/main`). The owner's branch changes only when they confirm "Merge into <branch>"; a conflict aborts the merge. Orys's documents go into `.aipm/` so they never collide with the owner's `docs/`.

### 17.5 Milestones

| M | Content |
|---|---|
| M8 | Modes in the model and API, the three-flow wizard, repository inspection, integration branch, new statuses |
| M9 | Mapper agent, map and proposals, proposal picker, planner from the map, rework rules |
| M10 | Plan editor (API and diagram), plan approval gate, models per role and per task |

### 17.6 Test mode: working on a copy

For existing projects Orys can work on a copy in `AIPM_SANDBOX_DIR` instead, without a single git command on the original: heavy and generated folders are skipped, the copy gets its own repository with no remotes and hooks disabled, uncommitted changes become a snapshot commit, and agents may not run git at all. A test checks that the original is byte for byte unchanged after the whole flow, `.git` included.

### 17.7 One long-lived Claude session per project

Builder runs of a project (mapper or architect, planner, every worker) continue one session, so context carries from task to task; the reviewer deliberately stays independent. `--resume` in print mode creates a new session id, so the project keeps the latest link. When the context grows beyond `AIPM_SESSION_MAX_CONTEXT` the session is replaced at the start of the next step (never in the middle of one); if a session cannot be resumed it starts afresh. The dashboard shows the command to open the session in interactive Claude Code.

## 18. Remote access: the dashboard in a browser, the engine at home

Orys can be opened as a web page from anywhere, while all the work still runs on the owner's computer: `claude` with their subscription, their repositories, git and the database. The server only signs people in and forwards traffic. When the computer is off, the page says so and nothing runs.

### 18.1 Parts

| Part | Runs on | Does |
|---|---|---|
| **Engine** (`orys serve`) | the owner's computer | everything Orys does: API, scheduler, loops, SQLite, `claude -p`, git |
| **Agent** (`orys serve --agent`) | the owner's computer, in the engine's process | opens a WebSocket to the relay itself (no open ports) and forwards incoming HTTP requests to the local engine, SSE included; switched on and off in the dashboard |
| **Relay** (`orys relay`) | a server | sign-in, session cookie, forwarding browser requests through the WebSocket; stores no project data |

The dashboard is served by the engine through the relay, so its version always matches the engine.

### 18.2 Protocol

WebSocket with JSON frames: relay → agent `req {id, method, url, headers, body?}` and `cancel {id}`; agent → relay `head`, `chunk`, `end`, `error`. Bodies are base64 and responses stream, so SSE works without a special case. Ping every 20 s; the agent reconnects with backoff from 1 to 30 s.

### 18.3 Security

Remote access to Orys means remote code execution on the computer (workers run with `bypassPermissions`). So:

- the relay requires a sign-in (scrypt hash, HMAC-signed `HttpOnly`, `Secure`, `SameSite=Lax` cookie, attempt limits) and accepts state-changing requests only from its own origin;
- it can sit behind an identity-aware proxy (Cloudflare Access is supported): the relay verifies the proxy's signed token itself, so a request that bypasses the proxy gets nowhere;
- the agent authenticates with a token compared in constant time, stored only on the server and in a `0600` file;
- the agent forwards only to `127.0.0.1:<port>`, strips cookies and authorization headers, and checks every request against an **allow-list of routes** (`src/relay/policy.ts`); the engine checks the same list for requests the agent marks as remote, so a new engine route stays local until it is added on purpose;
- **local confirmation:** merging into the owner's branch and creating a project wait for a click on the computer itself (a dialog that defaults to "Deny");
- security headers (CSP, frame options, `nosniff`, HSTS) on every response; deploys only from committed code.

### 18.4 Milestones

| M | Content |
|---|---|
| H1 | Relay and agent for one user and one computer |
| H2 | Agent inside `orys serve`, a background service, pairing a computer by code |
| H3 | Several users and computers (§18.5) |
| H4 | Distribution: installer, updates, macOS/Linux/Windows |

### 18.5 Hub: Orys for invited people

A separate public service through which invited people use Orys with **their own** computer:

- accounts through GitHub sign-in, opened only with a single-use invite (32 random bytes, stored hashed, valid for 7 days);
- a computer is paired with a code shown by `orys agent login --hub <url>` and confirmed in the signed-in browser (like the OAuth device flow);
- every request goes only to a device that belongs to the session's account; that check lives in one place and has attack tests;
- the hub never runs `claude` and never sees Claude credentials;
- rate limits per address, account and device; at most three devices per account; device tokens are stored hashed and can be revoked with one click;
- the hub process runs unprivileged in a strict service sandbox, on a machine whose outbound traffic cannot reach private networks;
- the owner's own computer is **not** on the hub: it uses a private relay, so even a fully compromised hub has no path to it;
- the owner manages invites, accounts and devices from their dashboard; the commands go to the hub over SSH from the owner's computer only, from a fixed list with checked arguments, and the page exists only where that is configured.

Remaining risk, accepted and documented: the dashboard is delivered through the hub, so a compromised hub could act as a signed-in user while they are signed in. Full protection from the server itself needs an app that is not delivered by the server (H4).

## 19. A plain summary before the technical details

Wherever the owner has to understand or approve something (plan approval, the decision after mapping, a new project's architecture, review decisions and escalations, task and phase results, the run list), they first see a short summary in plain words: what will be done or what happened, why, and what they have to decide. Technical details stay one click away, under "Details".

**Designed next:** a "Now" card on top of an active project that shows which agent works on which task and phase, a timer, the attempt and model, the latest activity and the last finished steps; phases as a progress bar, the task graph showing sub-steps (writing, checks, review), and while the subscription's limit is reached every active project would say until when it is paused.

## 20. Archiving and deleting a project

**Deleting (built):** a project can be deleted from the dashboard after a preview of what goes: its database rows and run logs, and optionally the folder Orys itself created (a sandbox copy or a scratch repository). The owner must type the project's name to confirm. The owner's own repository is never deleted.

**Archiving (designed, not built yet):** a finished or abandoned project leaves the main list without losing anything. An `archived_at` column rather than a new status keeps the state machine unchanged; the scheduler skips archived projects, their session is released, the page becomes read-only with "Restore", and restoring puts the project back exactly where it stopped. Deleting a sandbox copy is always a separate, explicit action.

## 21. Estimating when a project will be done (designed, not built yet)

Every project would always show how much is left, in words and numbers, for example "Done in about 2 days (Wednesday evening). 14 tasks left in 3 phases, about 9 h of agent work and 2 limit windows. Medium confidence."

- **What is estimated:** agent work (time and tokens) for every remaining step, multiplied by the expected number of attempts; turned into a calendar date using the project's fair share (§9), the subscription's limit windows and the time spent waiting for the owner; against the deadline, with what would help ("higher priority, fewer features, a stronger model").
- **Where the numbers come from:** before the plan, a rough size from the mapper or architect and the history of similar projects; after the plan, a size per task and measured durations, tokens and attempts from earlier runs; during execution, a per-project calibration factor from finished tasks.
- **Shown:** one line in the project list with a confidence label, a phase bar on the project page, and a small chart of how the estimated finish date moved over time. The estimate is part of the plan approval summary, so the owner knows what they approve.
- **Implementation:** a pure function over the project, its plan, run history and limit state, with tests on fixed histories, and a snapshot table for the history chart.

## 22. Vision: an AI that runs projects for you

The goal is for Orys to run projects instead of the owner: understand what they want and show them in advance what they will get, build, check like a user and hand over, and ask only what is truly theirs to decide.

### 22.1 The main metrics

| Metric | Measures |
|---|---|
| **Accepted as is** | Share of projects the owner accepts without changes |
| **Owner minutes per project** | Answers, approvals and reviewing the result, measured from events |
| **Promise accuracy** | Whether what was delivered matches the "what you will see" summary |
| **Estimate accuracy** | Real duration against the estimate (§21) |

### 22.2 What a real project manager does

Understands the goal (a conversation at the start and a living product document), shows before building (a summary, a sketch, an estimate), fits the process to the size and risk of the work, checks like a user (runs the app, walks through the acceptance criteria in a browser, compares screenshots with what was promised), delivers (deploy with smoke test and rollback), speaks up only when needed, learns the owner's taste and standards, and proposes what to do next.

### 22.3 Levels of autonomy

| Level | Orys | The owner |
|---|---|---|
| 1 | Executes a plan the owner approved | Approves the technical plan, checks the result |
| 2 | Understands the goal, shows the outcome in advance, adapts the process, checks like a user, hands over with a demo | Approves the outcome, looks at the demo |
| 3 | Delivers itself, runs several projects in parallel, watches a project after delivery | Reads a report now and then |
| 4 | Proposes the next work from goals, errors and monitoring | Approves the direction weekly |
| 5 | Runs the whole portfolio: priorities, subscription budget, what to stop | Sets the goals |

A level is not left before the previous level's metrics are reached on at least three real projects.

### 22.4 What stays with the owner even at level 5

Taste and direction (Orys learns them but does not invent them), risky decisions (production without staging, money, other people's data, deletion), and checking that the metrics still measure what the owner cares about.

### 22.5 First steps (level 2)

A summary before the start with "what you will see" and a rough estimate; a quick mode for small work; a handover with a demo and "Accept / Send back"; checking like a user in a browser; a "Now" card for the active project; then three real projects overnight, judged by §22.1.

### 22.6 Level 2, first round (done)

- **The master process measures the size of the work and adapts its steps** (`src/core/outcome.ts`): the planner returns a scope (size XS–XL, risk, whether the UI changes, whether the look is open), and the master code picks a process deterministically: **quick** (XS/S, low risk: one phase, no plan review, a review only at the end, 2 attempts), **standard** (at most 3 phases, reviews per profile) or **full** (L/XL or high risk: a review after every task).
- **What you will get, before building:** the plan carries an outcome (a plain summary, what you will see, what stays the same, open questions with proposed answers); the approval card shows the process, an estimate (minutes per size, calibrated from history once there are enough tasks of a size) and warnings, such as few visible changes in a UI project or a goal that is too broad.
- **Design directions:** when the UI changes and the look is open, a designer makes two or three static HTML mockups with screenshots after the plan; the owner picks one before the plan can be approved, and workers and reviewers get the choice.
- **Handover:** after the last phase an independent, read-only agent checks every promise against the code and the screenshots and writes a handover (summary, promises done/partial/missing, how to see it, what to know). The owner picks **Accept** or **Send back** with a note; sending back opens an "Owner feedback" phase, and the next handover checks the note too.
- **Metrics** (§22.1) on the overview page: accepted as is, promises fully kept, owner decisions per project.

### 22.7 Sketch before the plan

Agreement is reached on something the owner can see, not on text.

- **Who starts with a sketch** (`AIPM_SKETCH_FIRST`, on by default): every new project; existing code with a stated next goal; a UI redesign.
- **The sketch** (`src/loops/sketch.ts`, `prompts/sketch.md`): within minutes, one agent on its own branch makes something visible: screenshots in two or three directions when the look is open, or a demo (command and output) for non-UI work, plus what is real, what is faked, and the size of the real build.
- **The owner** (gate `approve_sketch`): "Change it" or "Try a different direction" make a new version in the same session; "That's it, build it properly" closes the sketch, with a direction picked when there are several.
- **After agreement:** small and medium work is planned right away from a short document derived from the sketch; large work gets the full architecture or map first. Planner, workers, reviews and handover all get the sketch: build what it shows, properly.
- **Less overhead:** task reviews run only where risk is not low (in the measured runs 13 of 13 task reviews approved).
- **Metric:** median minutes from start to the first sketch (target ≤ 10), on the overview page.

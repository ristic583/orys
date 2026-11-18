/**
 * Fastify API + SSE (SPEC §10). The scheduler is optional so the API can run
 * (and be tested) without it; `aipm serve` wires both together.
 */
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZodError, z } from "zod";
import type { App } from "../app.js";
import { InvalidTransition } from "../core/stateMachines.js";
import { phases as phasesTable, runs, tasks as tasksTable } from "../db/schema.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { BriefSchema } from "../projects/brief.js";
import { AIPM_ROOT } from "../config.js";
import { inspectRepo } from "../projects/inspect.js";
import { MergeRefused, mergeIntoBase } from "../projects/mergeBase.js";
import { decideAfterMapping, GateError, OwnerChoiceSchema, readMap } from "../projects/ownerGate.js";
import * as editor from "../projects/planEditor.js";
import { discoverRepos } from "../projects/discover.js";
import * as slots from "../sessions/slots.js";
import { createProjectFromBrief, getProject, RepoNotUsable, startProject } from "../projects/repo.js";
import { projects as projectsTable } from "../db/schema.js";
import { ProjectPatchSchema, updateProjectSettings } from "../projects/settings.js";
import { retryTask, skipTask } from "../projects/tasks.js";
import { answerAndUnblock } from "../projects/unblock.js";
import { runProbe } from "../scheduler/probe.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import * as q from "./queries.js";
import { currentActivity, summarizeRunLog } from "./runLog.js";
import * as owner from "../projects/outcome.js";
import { designsDir } from "../loops/design.js";
import { sketchDir } from "../loops/sketch.js";
import { SCREENS_DIR } from "../loops/execution.js";
import { createReadStream } from "node:fs";
import { REMOTE_MARKER_HEADER } from "../relay/protocol.js";
import { remoteDecision } from "../relay/policy.js";
import { DeleteRefused, deleteProject, deletionPreview } from "../projects/delete.js";
import type { RemoteAccess } from "../relay/remote.js";
import { HubInputError, type HubAdmin, type HubCommand } from "./hubAdmin.js";

export const WEB_DIST = resolve(import.meta.dirname, "../../web/dist");

export type ServerOptions = {
  app: App;
  scheduler?: Scheduler;
  /** Serve the built dashboard from here (default web/dist, if it exists). */
  webDir?: string | null;
  /** SSE poll interval for new events. */
  ssePollMs?: number;
  /** Remote access through the relay (`orys serve`); the dashboard turns it on and off. */
  remote?: RemoteAccess;
  /** The owner's Hub page (SPEC §18.5); only on the computer that manages the hub. */
  hubAdmin?: HubAdmin;
  logger?: boolean;
};

class NotFound extends Error {}

const Message = z.object({ message: z.string().trim().min(1).max(10_000) });
const OptionalMessage = z.object({ message: z.string().trim().max(10_000).optional() }).default({});

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { app, scheduler } = opts;
  const { db } = app;
  // forceCloseConnections: open SSE streams must not keep close() waiting.
  const server = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });

  // Requests from the hosted dashboard come through the agent, which marks them and already
  // applied the remote policy. Checked again here, so an engine route never opens up by accident.
  const viaRelay = (req: { headers: Record<string, unknown> }) => req.headers[REMOTE_MARKER_HEADER] === "1";
  server.addHook("onRequest", async (req, reply) => {
    if (!viaRelay(req)) return;
    if (remoteDecision(req.method, req.url.split("?")[0] ?? "/").kind === "deny") {
      return reply.code(403).send({ error: "Not available from the hosted dashboard. Do this on your computer." });
    }
  });

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid input", issues: err.issues });
    if (err instanceof InvalidTransition) return reply.code(409).send({ error: err.message });
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFound || /not found/.test(msg)) return reply.code(404).send({ error: msg });
    if (/is not blocked/.test(msg) || err instanceof MergeRefused || err instanceof GateError || /already exists/.test(msg)) return reply.code(409).send({ error: msg });
    if (err instanceof RepoNotUsable) return reply.code(422).send({ error: msg, problems: err.problems });
    if (err instanceof editor.PlanInvalid) return reply.code(422).send({ error: msg, problems: err.problems });
    if (err instanceof editor.EditRefused || err instanceof slots.SlotError || err instanceof owner.OwnerActionRefused || err instanceof DeleteRefused) return reply.code(409).send({ error: msg });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: msg });
    server.log.error(err);
    return reply.code(500).send({ error: msg });
  });

  const project = (id: string) => getProject(db, id);

  // ─────────── projects ───────────
  server.get("/api/projects", async () => q.projectSummaries(db));
  server.post("/api/projects", async (req, reply) => {
    const brief = BriefSchema.parse(req.body);
    const p = await createProjectFromBrief(db, brief, { projectsDir: app.config.AIPM_PROJECTS_DIR, defaultProfile: app.config.AIPM_DEFAULT_PROFILE, aipmRoot: AIPM_ROOT, sandboxDir: app.config.AIPM_SANDBOX_DIR, claimSessionSlot: true });
    return reply.code(201).send(p);
  });
  /** Wizard: git repositories on this machine to pick from (cached for two minutes; ?refresh=1 rescans). */
  let found: { at: number; data: Awaited<ReturnType<typeof discoverRepos>> } | null = null;
  server.get<{ Querystring: { refresh?: string } }>("/api/repo/discover", async (req) => {
    if (!found || req.query.refresh || Date.now() - found.at > 120_000) {
      const data = await discoverRepos({ roots: app.config.AIPM_REPO_ROOTS, exclude: [AIPM_ROOT, app.config.AIPM_SANDBOX_DIR] });
      found = { at: Date.now(), data };
    }
    const taken = new Map(db.select({ repoPath: projectsTable.repoPath, sourcePath: projectsTable.sourcePath, slug: projectsTable.slug }).from(projectsTable).all().flatMap((p) => [[p.repoPath, p.slug], ...(p.sourcePath ? [[p.sourcePath, p.slug]] : [])] as [string, string][]));
    return { ...found.data, roots: app.config.AIPM_REPO_ROOTS, repos: found.data.repos.map((r) => ({ ...r, project: taken.get(r.path) ?? null })) };
  });
  /** Wizard: check an existing repository before creating a project for it. */
  server.post("/api/repo/inspect", async (req) => {
    const { path, copy } = z.object({ path: z.string(), copy: z.boolean().default(false) }).parse(req.body);
    const taken = new Map(db.select({ repoPath: projectsTable.repoPath, slug: projectsTable.slug }).from(projectsTable).all().map((p) => [p.repoPath, p.slug]));
    return inspectRepo(path, { taken, aipmRoot: AIPM_ROOT, forCopy: copy });
  });
  server.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => q.projectDetail(db, req.params.id));
  server.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const patch = ProjectPatchSchema.parse(req.body ?? {});
    const p = updateProjectSettings(db, req.params.id, patch);
    // Pause means now: the running claude call is aborted (task → interrupted, no attempt used).
    if (patch.paused) scheduler?.interrupt(p.id);
    return p;
  });
  /** What deleting would remove; the dashboard shows it before asking. */
  server.get<{ Params: { id: string } }>("/api/projects/:id/deletion", async (req) => deletionPreview(db, app.config, req.params.id));
  server.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const body = z.object({ confirm: z.string(), removeFolder: z.boolean().default(false) }).parse(req.body ?? {});
    return deleteProject(db, app.config, req.params.id, { ...body, busy: (id) => scheduler?.busy(id) ?? false });
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/start", async (req) => startProject(db, project(req.params.id), { sketch: app.config.AIPM_SKETCH_FIRST }));
  /** The mapper's structured map (proposals, baseline, commands) for the owner's choice. */
  server.get<{ Params: { id: string } }>("/api/projects/:id/map", async (req) => {
    const p = project(req.params.id);
    return { map: readMap(p), markdown: q.readDoc(p, "architecture") };
  });
  /** Owner gate after mapping: which proposals to plan, notes, (rework) confirmed criteria. */
  server.post<{ Params: { id: string } }>("/api/projects/:id/choose", async (req) =>
    decideAfterMapping(app, req.params.id, OwnerChoiceSchema.parse(req.body ?? {})),
  );
  // ─────────── plan editor (SPEC §17.3); every edit answers with the whole plan ───────────
  const phasesOfTask = (taskId: string) => {
    const t = db.select({ phaseId: tasksTable.phaseId }).from(tasksTable).where(eq(tasksTable.id, taskId)).get();
    if (!t) throw new NotFound(`task not found: ${taskId}`);
    return t.phaseId;
  };
  const projectOfPhase = (phaseId: string) => {
    const ph = db.select({ projectId: phasesTable.projectId }).from(phasesTable).where(eq(phasesTable.id, phaseId)).get();
    if (!ph) throw new NotFound(`phase not found: ${phaseId}`);
    return ph.projectId;
  };
  const plan = (projectId: string) => q.phasesWithTasks(db, projectId);
  server.patch<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const pid = projectOfPhase(phasesOfTask(req.params.id));
    editor.updateTask(db, req.params.id, editor.TaskPatchSchema.parse(req.body ?? {}));
    return plan(pid);
  });
  server.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const pid = projectOfPhase(phasesOfTask(req.params.id));
    editor.deleteTask(db, req.params.id);
    return plan(pid);
  });
  server.post<{ Params: { id: string } }>("/api/tasks/:id/move", async (req) => {
    const pid = projectOfPhase(phasesOfTask(req.params.id));
    editor.moveTask(db, req.params.id, editor.MoveSchema.parse(req.body ?? {}));
    return plan(pid);
  });
  server.post<{ Params: { id: string } }>("/api/phases/:id/tasks", async (req) => {
    const pid = projectOfPhase(req.params.id);
    editor.addTask(db, req.params.id, editor.NewTaskSchema.parse(req.body ?? {}));
    return plan(pid);
  });
  server.patch<{ Params: { id: string } }>("/api/phases/:id", async (req) => {
    const pid = projectOfPhase(req.params.id);
    editor.updatePhase(db, req.params.id, editor.PhasePatchSchema.parse(req.body ?? {}));
    return plan(pid);
  });
  server.delete<{ Params: { id: string } }>("/api/phases/:id", async (req) => {
    const pid = projectOfPhase(req.params.id);
    editor.deletePhase(db, req.params.id);
    return plan(pid);
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/phases", async (req) => {
    const p = project(req.params.id);
    editor.addPhase(db, p.id, editor.NewPhaseSchema.parse(req.body ?? {}));
    return plan(p.id);
  });
  // ─────────── project sessions (SPEC §17.7) ───────────
  const busy = (projectId: string) => scheduler?.busy(projectId) ?? false;
  server.get("/api/sessions", async () => q.sessionsOverview(db, busy, app.config.AIPM_SESSION_MAX_CONTEXT));
  server.post<{ Params: { id: string; action: string } }>("/api/projects/:id/session/:action", async (req) => {
    const p = project(req.params.id);
    z.literal("reset").parse(req.params.action);
    if (busy(p.id)) throw new slots.SlotError("an agent is using this session right now; pause the project first");
    slots.resetSession(db, p.id, "owner");
    return q.sessionView(db, p);
  });
  // ─────────── level 2: outcome card, design directions, handoff (SPEC §22.5) ───────────
  server.get<{ Params: { id: string } }>("/api/projects/:id/outcome", async (req) => owner.outcomeView(db, req.params.id));
  server.post<{ Params: { id: string } }>("/api/projects/:id/outcome/answers", async (req) => {
    owner.setAnswers(db, req.params.id, owner.AnswersSchema.parse(req.body ?? {}).answers);
    return owner.outcomeView(db, req.params.id);
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/design-choice", async (req) => {
    owner.chooseDesign(db, req.params.id, owner.DesignChoiceSchema.parse(req.body ?? {}));
    return owner.outcomeView(db, req.params.id);
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/handoff/accept", async (req) => owner.acceptHandoff(db, req.params.id));
  server.post<{ Params: { id: string } }>("/api/projects/:id/handoff/return", async (req) => owner.returnHandoff(db, req.params.id, Message.parse(req.body).message));
  server.get("/api/metrics", async () => owner.ownerMetrics(db));
  // Sketch first (SPEC §22.7)
  server.get<{ Params: { id: string } }>("/api/projects/:id/sketch", async (req) => owner.sketchView(db, req.params.id));
  server.post<{ Params: { id: string } }>("/api/projects/:id/sketch/revise", async (req) => {
    owner.reviseSketch(db, req.params.id, owner.SketchReviseSchema.parse(req.body ?? {}));
    return owner.sketchView(db, req.params.id);
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/sketch/approve", async (req) => {
    await owner.approveSketch(app, req.params.id, owner.SketchApproveSchema.parse(req.body ?? {}));
    return owner.sketchView(db, req.params.id);
  });
  server.get<{ Params: { id: string; version: string; file: string } }>("/api/projects/:id/sketch/files/:version/:file", async (req, reply) => {
    const p = project(req.params.id);
    if (!/^\d+$/.test(req.params.version)) throw new NotFound("no such sketch version");
    return sendProjectFile(join(p.repoPath, sketchDir(Number(req.params.version))), req.params.file, reply);
  });
  /** Design mockups and worker screenshots, for the dashboard (file names only, no paths). */
  const sendProjectFile = (dir: string, file: string, reply: import("fastify").FastifyReply) => {
    if (!/^[a-z0-9][a-z0-9._-]*\.(html|png)$/i.test(file) || file.includes("..")) throw new NotFound(`no such file: ${file}`);
    const path = join(dir, file);
    if (!existsSync(path)) throw new NotFound(`no such file: ${file}`);
    // Mockups are the agents' static HTML: shown sandboxed, no scripts.
    if (file.endsWith(".html")) reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: 'self'; sandbox");
    return reply.type(file.endsWith(".png") ? "image/png" : "text/html; charset=utf-8").send(createReadStream(path));
  };
  server.get<{ Params: { id: string; file: string } }>("/api/projects/:id/designs/:file", async (req, reply) => {
    const p = project(req.params.id);
    return sendProjectFile(join(p.repoPath, designsDir(p)), req.params.file, reply);
  });
  server.get<{ Params: { id: string; file: string } }>("/api/projects/:id/screens/:file", async (req, reply) => {
    const p = project(req.params.id);
    return sendProjectFile(join(p.repoPath, SCREENS_DIR), req.params.file, reply);
  });
  server.post<{ Params: { id: string } }>("/api/projects/:id/approve-plan", async (req) => editor.approvePlan(db, project(req.params.id).id));
  server.post<{ Params: { id: string } }>("/api/projects/:id/merge-base", async (req) =>
    mergeIntoBase(app, req.params.id, { busy }),
  );
  server.post<{ Params: { id: string } }>("/api/projects/:id/unblock", async (req) => answerAndUnblock(app, req.params.id, Message.parse(req.body).message));
  server.get<{ Params: { id: string } }>("/api/projects/:id/phases", async (req) => q.phasesWithTasks(db, project(req.params.id).id));
  server.get<{ Params: { id: string } }>("/api/projects/:id/decisions", async (req) => q.projectDecisions(db, project(req.params.id).id));
  server.get<{ Params: { id: string } }>("/api/projects/:id/events", async (req) => q.recentEvents(db, project(req.params.id).id));
  server.get<{ Params: { id: string; name: string } }>("/api/projects/:id/docs/:name", async (req) => {
    const name = z.enum(q.DOC_NAMES).parse(req.params.name);
    const p = project(req.params.id);
    return { name, path: q.docPath(p, name), content: q.readDoc(p, name) };
  });

  // ─────────── tasks ───────────
  server.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (req) => retryTask(db, req.params.id, OptionalMessage.parse(req.body ?? {}).message));
  server.post<{ Params: { id: string } }>("/api/tasks/:id/skip", async (req) => skipTask(db, req.params.id, OptionalMessage.parse(req.body ?? {}).message));
  server.get<{ Params: { id: string } }>("/api/tasks/:id/verifications", async (req) => q.taskVerifications(db, req.params.id));

  // ─────────── runs & usage ───────────
  server.get<{ Querystring: { project_id?: string; task_id?: string; limit?: string } }>("/api/runs", async (req) => {
    const projectId = req.query.project_id ? project(req.query.project_id).id : undefined;
    return q.listRuns(db, { projectId, taskId: req.query.task_id, limit: req.query.limit ? Number(req.query.limit) : undefined });
  });
  server.get<{ Params: { id: string } }>("/api/runs/:id/log", async (req) => {
    const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
    if (!run) throw new NotFound(`run not found: ${req.params.id}`);
    return { run, ...summarizeRunLog(run.logPath) };
  });
  server.get<{ Querystring: { range?: string } }>("/api/usage", async (req) => {
    const days = Number(/^(\d+)d$/.exec(req.query.range ?? "7d")?.[1] ?? 7);
    return { days, rows: q.usage(db, Math.min(Math.max(days, 1), 90)) };
  });

  // ─────────── status ───────────
  /** The claude run a project is in right now (if any) and what it is doing. */
  const liveRun = (projectId: string) => {
    const run = db.select().from(runs).where(and(eq(runs.projectId, projectId), isNull(runs.endedAt))).orderBy(desc(runs.id)).get();
    if (!run) return { run: null, activity: null };
    const task = run.taskId ? db.select({ key: tasksTable.key, title: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, run.taskId)).get() : undefined;
    return {
      run: { id: run.id, kind: run.kind, model: run.model, startedAt: run.startedAt, taskKey: task?.key ?? null, taskTitle: task?.title ?? null },
      activity: currentActivity(run.logPath)?.text ?? null,
    };
  };
  server.get("/api/status", async () => ({
    hubAdmin: !!opts.hubAdmin,
    limit: q.limitStatus(db),
    scheduler: scheduler
      ? {
          running: !scheduler.stopping,
          current: scheduler.current,
          jobs: [...scheduler.jobs.values()].map((j) => ({ ...j, ...liveRun(j.projectId) })),
          queue: scheduler.rank().map((c) => ({ slug: c.slug, score: c.score, weight: c.weight, urgency: c.urgency, share: c.share, locality: c.locality })),
        }
      : null,
  }));
  server.get<{ Querystring: { limit?: string } }>("/api/events", async (req) =>
    q.recentEvents(db, null, Math.min(Number(req.query.limit ?? 50) || 50, 200)),
  );
  server.post("/api/probe", async () => {
    if (scheduler?.jobs.size) return { ok: false, reason: "agents are running; the scheduler probes by itself when needed" };
    return runProbe(app);
  });

  // ─────────── remote access (SPEC §18) ───────────
  server.get("/api/remote", async (req) => ({ ...(opts.remote?.status() ?? { available: false }), via: viaRelay(req) ? "remote" : "local" }));
  server.post("/api/remote/enable", async (req, reply) => {
    if (!opts.remote) return reply.code(409).send({ error: "Remote access runs only under `orys serve`." });
    if (viaRelay(req)) return reply.code(403).send({ error: "Turn remote access on from the computer itself." });
    return opts.remote.enable();
  });
  server.post("/api/remote/disable", async (req, reply) => {
    if (!opts.remote) return reply.code(409).send({ error: "Remote access runs only under `orys serve`." });
    return opts.remote.disable(viaRelay(req) ? 500 : 0);
  });

  // ─────────── the Orys hub, for its owner (SPEC §18.5) ───────────
  const hubRun = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, cmd: HubCommand) => {
    if (!opts.hubAdmin) return reply.code(404).send({ error: "This computer does not manage an Orys hub." });
    try {
      return await opts.hubAdmin.run(cmd);
    } catch (e) {
      return reply.code(e instanceof HubInputError ? 400 : 502).send({ error: (e as Error).message });
    }
  };
  server.get("/api/hub-admin", async (_req, reply) => {
    const r = await hubRun(reply, ["overview"]);
    return r && typeof r === "object" && "hubUrl" in r ? { ...r, via: opts.hubAdmin!.via } : r;
  });
  server.post<{ Body: { note?: unknown } }>("/api/hub-admin/invite", async (req, reply) => hubRun(reply, ["invite", typeof req.body?.note === "string" ? req.body.note : ""]));
  server.post<{ Params: { id: string } }>("/api/hub-admin/invites/:id/cancel", async (req, reply) => hubRun(reply, ["cancel-invite", Number(req.params.id)]));
  server.post<{ Params: { id: string } }>("/api/hub-admin/devices/:id/revoke", async (req, reply) => hubRun(reply, ["revoke-device", Number(req.params.id)]));
  server.post<{ Params: { login: string; action: string } }>("/api/hub-admin/users/:login/:action", async (req, reply) => {
    const { login, action } = req.params;
    if (action !== "disable" && action !== "enable") return reply.code(404).send({ error: "not_found" });
    return hubRun(reply, [action, login]);
  });

  // ─────────── live updates (SSE) ───────────
  server.get("/api/events/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    let last = q.latestEventId(db);
    const jobs = () => (scheduler ? [...scheduler.jobs.values()] : []);
    let lastJob = JSON.stringify(jobs());
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("hello", { lastEventId: last });
    const poll = setInterval(() => {
      for (const e of q.eventsAfter(db, last)) {
        send("aipm", e);
        last = e.id;
      }
      const now = JSON.stringify(jobs());
      if (now !== lastJob) {
        lastJob = now;
        send("job", scheduler?.current ?? null);
        send("jobs", jobs());
      }
    }, opts.ssePollMs ?? 1_000);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    });
  });

  // ─────────── dashboard ───────────
  const webDir = opts.webDir === undefined ? WEB_DIST : opts.webDir;
  if (webDir && existsSync(join(webDir, "index.html"))) {
    server.register(fastifyStatic, { root: webDir });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html"); // client-side routing
    });
  }
  return server;
}

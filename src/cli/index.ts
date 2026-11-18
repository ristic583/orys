#!/usr/bin/env tsx
import { Command } from "commander";
import { asc, desc, eq, sql } from "drizzle-orm";
import { createApp } from "../app.js";
import { isBlocked } from "../claude/limits.js";
import { phases, projects, runs, tasks } from "../db/schema.js";
import { recoverInFlight, runExecution } from "../loops/execution.js";
import { runPlanningToCompletion } from "../loops/planning.js";
import { loadBriefFile } from "../projects/brief.js";
import { createProjectFromBrief, getProject, startProject } from "../projects/repo.js";
import { mergeIntoBase } from "../projects/mergeBase.js";
import { approvePlan } from "../projects/planEditor.js";
import * as slots from "../sessions/slots.js";
import { sessionsOverview } from "../server/queries.js";
import { AIPM_ROOT, loadConfig } from "../config.js";
import { answerAndUnblock } from "../projects/unblock.js";
import { loadLimit } from "../runs/limitStore.js";
import { runProbe } from "../scheduler/probe.js";
import { Scheduler, type TickResult } from "../scheduler/scheduler.js";
import { PROFILES } from "../core/profiles.js";
import { ProjectPatchSchema, updateProjectSettings } from "../projects/settings.js";
import { buildServer, WEB_DIST } from "../server/index.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { startAgent } from "../relay/agent.js";
import { macDialogConfirm } from "../relay/confirm.js";
import { loadHubAdmin, type HubAdmin } from "../server/hubAdmin.js";
import { AGENT_CONFIG, accessHeaders, readAgentConfig, RemoteAccess, saveAgentConfig } from "../relay/remote.js";
import { pairWithHub, refuseToReplace, hubBase } from "../relay/pairing.js";
import { userInfo } from "node:os";

const program = new Command().name("orys").description("Orys: plans and builds projects with Claude Code workers");

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const project = program.command("project").description("manage projects");

project
  .command("new")
  .description("create a project from a brief file (YAML or JSON)")
  .requiredOption("-f, --file <path>", "brief file")
  .action(async (opts: { file: string }) => {
    const app = createApp();
    const brief = loadBriefFile(opts.file);
    const p = await createProjectFromBrief(app.db, brief, { projectsDir: app.config.AIPM_PROJECTS_DIR, defaultProfile: app.config.AIPM_DEFAULT_PROFILE, aipmRoot: AIPM_ROOT, sandboxDir: app.config.AIPM_SANDBOX_DIR, claimSessionSlot: true });
    console.log(`created ${p.slug} (${p.mode}, ${p.profile}, priority ${p.priority}) → ${p.repoPath}${p.baseBranch ? ` [base branch ${p.baseBranch}, Orys works on ${p.integrationBranch}]` : ""}`);
  });

project
  .command("list")
  .description("list projects")
  .action(() => {
    const app = createApp();
    const rows = app.db.select().from(projects).orderBy(desc(projects.priority), asc(projects.createdAt)).all();
    if (!rows.length) return console.log("no projects yet — create one with: aipm project new -f brief.yaml");
    for (const p of rows) {
      const [t] = app.db
        .select({ total: sql<number>`count(*)`, done: sql<number>`sum(case when ${tasks.status} in ('done','skipped') then 1 else 0 end)` })
        .from(tasks)
        .innerJoin(phases, eq(tasks.phaseId, phases.id))
        .where(eq(phases.projectId, p.id))
        .all();
      const progress = t && t.total ? ` ${t.done ?? 0}/${t.total} tasks` : "";
      const flags = [p.paused ? "paused" : null, p.blockedReason ? `blocked: ${p.blockedReason}` : null].filter(Boolean).join(" · ");
      console.log(`${p.slug.padEnd(20)} ${p.status.padEnd(12)} P${p.priority} ${p.profile.padEnd(8)}${progress}${flags ? `  (${flags})` : ""}`);
    }
  });

project
  .command("start <slug>")
  .description("run architecture and planning (loops 1–2) until the plan is approved or input is needed")
  .action(async (slug: string) => {
    const app = createApp();
    let p = getProject(app.db, slug);
    if (p.status === "draft") p = startProject(app.db, p, { sketch: app.config.AIPM_SKETCH_FIRST });
    if (p.status === "mapping") {
      console.log(`${slug} is mapping its existing repository; the mapper agent runs under \`aipm serve\` / \`aipm work\` (M9).`);
      return;
    }
    if (p.status !== "architecting" && p.status !== "planning") {
      console.log(`${slug} is ${p.status}; nothing to plan`);
      return;
    }
    const block = isBlocked(loadLimit(app.db), new Date());
    if (block.blocked) {
      console.log(`cannot start: ${block.reason}${block.until ? ` (until ${block.until.toLocaleString()})` : ""}`);
      process.exitCode = 2;
      return;
    }
    const result = await runPlanningToCompletion(app, p.id, (r) => console.log(`[${new Date().toLocaleTimeString()}] ${r.status}: ${r.message}`));
    p = getProject(app.db, slug);
    console.log(`\n${slug}: ${p.status}${p.blockedReason ? `\n→ ${p.blockedReason}\n  answer with: aipm project answer ${slug} "<your answer>"` : ""}`);
    if (p.ownerGate === "approve_plan") console.log(`→ review the plan in the dashboard, or approve it with: aipm project approve ${slug}`);
    if (result.status === "failed" || result.status === "interrupted") process.exitCode = 1;
  });

project
  .command("run <slug>")
  .description("execute tasks (loop 3) until the project needs input, hits a limit, or is done")
  .option("-n, --tasks <n>", "stop after this many tasks are done", (v) => Number.parseInt(v, 10))
  .action(async (slug: string, opts: { tasks?: number }) => {
    const app = createApp();
    const recovered = recoverInFlight(app.db);
    if (recovered) console.log(`recovered ${recovered} interrupted task(s)`);
    const block = isBlocked(loadLimit(app.db), new Date());
    if (block.blocked) {
      console.log(`cannot run: ${block.reason}${block.until ? ` (until ${block.until.toLocaleString()})` : ""}`);
      process.exitCode = 2;
      return;
    }
    const ac = new AbortController();
    onShutdownSignal(() => {
      console.log("\nstopping after the current step… (Ctrl+C again to force)");
      ac.abort();
    });
    const p0 = getProject(app.db, slug);
    const result = await runExecution(app, p0.id, {
      stopAfterTasksDone: opts.tasks,
      signal: ac.signal,
      onStep: (r) => console.log(`[${new Date().toLocaleTimeString()}] ${r.status}: ${r.message}`),
    });
    const p = getProject(app.db, slug);
    console.log(`\n${slug}: ${p.status}${p.blockedReason ? `\n→ ${p.blockedReason}\n  answer with: aipm project answer ${slug} "<your answer>"` : ""}`);
    if (result.status === "failed") process.exitCode = 1;
  });

project
  .command("approve <slug>")
  .description("approve the reviewed plan; execution starts")
  .action((slug: string) => {
    const app = createApp();
    const p = approvePlan(app.db, getProject(app.db, slug).id);
    console.log(`${slug}: plan approved → ${p.status}. Agents start with \`aipm serve\` or \`aipm work\`.`);
  });

project
  .command("merge <slug>")
  .description("existing repo: merge Orys's integration branch into your base branch (project must be paused or done)")
  .action(async (slug: string) => {
    const app = createApp();
    const r = await mergeIntoBase(app, slug);
    console.log(`merged ${r.commits} commit(s) into ${r.into}`);
  });

project
  .command("answer <slug> <message>")
  .description("answer a blocked project; the answer goes to the next author run")
  .action((slug: string, message: string) => {
    const app = createApp();
    const p = answerAndUnblock(app, slug, message);
    const next = p.status === "executing" ? "run" : "start";
    console.log(`${slug} unblocked → ${p.status}. Continue with: aipm project ${next} ${slug}`);
  });

project
  .command("pause <slug>")
  .description("stop scheduling work for a project (the current step finishes)")
  .action((slug: string) => setPaused(slug, true));

project
  .command("resume <slug>")
  .description("allow the scheduler to work on a paused project again")
  .action((slug: string) => setPaused(slug, false));

project
  .command("set <slug>")
  .description("change scheduling settings")
  .option("-p, --priority <n>", "1 (low) … 5 (high)", (v) => Number.parseInt(v, 10))
  .option("--profile <name>", `one of: ${Object.keys(PROFILES).join(", ")}`)
  .option("-d, --deadline <date>", "ISO date, or 'none'")
  .action((slug: string, opts: { priority?: number; profile?: string; deadline?: string }) => {
    const app = createApp();
    const patch = {
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline === "none" ? null : opts.deadline } : {}),
    };
    if (!Object.keys(patch).length) return console.log("nothing to change");
    const row = updateProjectSettings(app.db, slug, ProjectPatchSchema.parse(patch));
    console.log(`${slug}: priority ${row.priority}, profile ${row.profile}, deadline ${row.deadline?.toISOString().slice(0, 10) ?? "none"}`);
  });

function setPaused(slug: string, paused: boolean) {
  const app = createApp();
  updateProjectSettings(app.db, slug, { paused });
  console.log(`${slug} ${paused ? "paused" : "resumed"}`);
}

/**
 * Graceful stop on SIGINT/SIGTERM. Handlers stay installed (a stray second
 * SIGTERM must not kill us mid-shutdown); a second Ctrl+C forces exit.
 */
function onShutdownSignal(stop: () => void | Promise<void>) {
  let stopping = false;
  const handle = (sig: NodeJS.Signals) => {
    if (stopping) {
      if (sig === "SIGINT") process.exit(130);
      return;
    }
    stopping = true;
    void stop();
  };
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
}

const ts = () => `[${new Date().toLocaleTimeString()}]`;

function describeTick(r: TickResult): string | null {
  switch (r.kind) {
    case "ran":
      return `${ts()} ${r.slug} ${r.step.status}: ${r.step.message}`;
    case "waiting":
      return `${ts()} waiting — ${r.reason}${r.until ? ` (until ${r.until.toLocaleString()})` : ""}`;
    case "probed":
      return `${ts()} limit probe: ${r.ok ? "ok, resuming" : `still blocked (${r.reason ?? "?"})${r.until ? ` until ${r.until.toLocaleString()}` : ""}`}`;
    case "idle":
      return `${ts()} idle — no project has work`;
    case "stopped":
      return `${ts()} stopped`;
  }
}

program
  .command("work")
  .description("run the scheduler: works on all projects by priority and fair share, waits out limits, resumes after restarts")
  .option("--until-idle", "exit when no project has work instead of waiting for more")
  .action(async (opts: { untilIdle?: boolean }) => {
    const app = createApp();
    const scheduler = new Scheduler(app);
    onShutdownSignal(() => {
      console.log(`\n${ts()} stopping: the running claude call is interrupted (resumable); git/verify steps finish… (Ctrl+C again to force)`);
      scheduler.stop();
    });
    let lastQuiet = "";
    await scheduler.run({
      untilIdle: opts.untilIdle,
      onTick: (r) => {
        const line = describeTick(r);
        if (!line) return;
        // Waiting/idle ticks repeat every few seconds: print them only when they change.
        const quiet = r.kind === "waiting" || r.kind === "idle" ? line.replace(/^\[[^\]]+\] /, "") : "";
        if (!quiet || quiet !== lastQuiet) console.log(line);
        lastQuiet = quiet;
      },
    });
  });

program
  .command("serve")
  .description("API + dashboard + scheduler (http://localhost:4317)")
  .option("--no-scheduler", "only serve the API and dashboard; do not run any agents")
  .option("--host <host>", "interface to listen on", "127.0.0.1")
  .option("--agent", "connect to the Orys relay at startup, unless remote access was turned off in the dashboard (SPEC §18)")
  .option("--keep-awake", "keep this Mac from idle sleep while Orys runs (macOS caffeinate)")
  .action(async (opts: { scheduler: boolean; host: string; agent?: boolean; keepAwake?: boolean }) => {
    const app = createApp();
    const scheduler = opts.scheduler ? new Scheduler(app) : undefined;
    const remote = new RemoteAccess({
      statePath: join(dirname(app.config.AIPM_DB), "remote.json"),
      target: `http://127.0.0.1:${app.config.AIPM_PORT}`,
      confirm: macDialogConfirm({ log: (l) => console.log(`${ts()} ${l}`) }),
      log: (l) => console.log(`${ts()} ${l}`),
    });
    let hubAdmin: HubAdmin | undefined;
    try {
      hubAdmin = loadHubAdmin();
      if (hubAdmin) console.log(`${ts()} Hub page on (${hubAdmin.via})`);
    } catch (e) {
      console.log(`${ts()} Hub page off: ${(e as Error).message}`);
    }
    const server = buildServer({ app, scheduler, remote, hubAdmin });
    const url = await server.listen({ port: app.config.AIPM_PORT, host: opts.host });
    console.log(`${ts()} Orys at ${url.replace("127.0.0.1", "localhost")}`);
    if (opts.agent) remote.boot();
    // caffeinate -w ends by itself when this process does.
    if (opts.keepAwake && process.platform === "darwin") spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).unref();
    if (!existsSync(join(WEB_DIST, "index.html"))) console.log("  (dashboard not built: run `pnpm build`, or `pnpm web:dev` for development)");
    let lastQuiet = "";
    const loop = scheduler?.run({
      onTick: (r) => {
        const line = describeTick(r);
        if (!line) return;
        const quiet = r.kind === "waiting" || r.kind === "idle" ? line.replace(/^\[[^\]]+\] /, "") : "";
        if (!quiet || quiet !== lastQuiet) console.log(line);
        lastQuiet = quiet;
      },
    });
    onShutdownSignal(async () => {
      console.log(`\n${ts()} shutting down: the running claude call is interrupted (resumable)… (Ctrl+C again to force)`);
      scheduler?.stop();
      remote.stop();
      await loop;
      await server.close();
      console.log(`${ts()} stopped cleanly`);
      process.exit(0);
    });
  });

program
  .command("sessions")
  .description("project sessions: one long-lived Claude session per project")
  .action(() => {
    const app = createApp();
    const view = sessionsOverview(app.db, () => false, app.config.AIPM_SESSION_MAX_CONTEXT);
    if (!view.slots.length) console.log("no project has a session yet");
    for (const s of view.slots) {
      const size = s.contextTokens ? ` · ${Math.round(s.contextTokens / 1000)}k context` : "";
      console.log(`${s.projectSlug ?? "(free)"}${size} · ${s.runs} runs${s.rotations ? ` · ${s.rotations} rotations` : ""}`);
      if (s.resumeCommand) console.log(`     ${s.resumeCommand}`);
    }
  });

project
  .command("session <slug> <action>")
  .description("reset: the project's next builder run starts a fresh Claude session")
  .action((slug: string, action: string) => {
    const app = createApp();
    const p = getProject(app.db, slug);
    if (action !== "reset") throw new Error("the only action is reset (sessions are created by themselves when needed)");
    slots.resetSession(app.db, p.id, "owner");
  });

program
  .command("probe")
  .description("check now whether the subscription accepts work (one tiny haiku call)")
  .action(async () => {
    const app = createApp();
    const r = await runProbe(app);
    console.log(r.ok ? "ok — work can run" : `blocked: ${r.reason ?? "?"}${r.until ? ` (until ${r.until.toLocaleString()})` : ""}`);
    if (!r.ok) process.exitCode = 2;
  });

program
  .command("status")
  .description("limit state and token usage over the last 7 days")
  .action(() => {
    const app = createApp();
    const limit = loadLimit(app.db);
    const b = isBlocked(limit, new Date());
    console.log(
      `limit: ${limit.status}${limit.rateLimitType ? ` (${limit.rateLimitType})` : ""}` +
        `${limit.utilization != null ? `, utilization ${Math.round(limit.utilization * 100)}%` : ""}` +
        `${limit.resetAt ? `, resets ${limit.resetAt.toLocaleString()}` : ""}` +
        `${b.blocked ? `  ⛔ ${b.reason}` : ""}`,
    );
    const since = new Date(Date.now() - 7 * 864e5);
    const rows = app.db
      .select({
        slug: projects.slug,
        kind: runs.kind,
        n: sql<number>`count(*)`,
        tokens: sql<number>`sum(${runs.inputTokens} + ${runs.outputTokens} + ${runs.cacheCreationTokens})`,
        cached: sql<number>`sum(${runs.cacheReadTokens})`,
        cost: sql<number>`sum(${runs.costUsd})`,
      })
      .from(runs)
      .leftJoin(projects, eq(runs.projectId, projects.id))
      .where(sql`${runs.startedAt} >= ${since.getTime()}`)
      .groupBy(projects.slug, runs.kind)
      .all();
    if (!rows.length) return console.log("no runs in the last 7 days");
    console.log("\nlast 7 days:");
    for (const r of rows) {
      console.log(`  ${(r.slug ?? "(none)").padEnd(20)} ${r.kind.padEnd(14)} ${String(r.n).padStart(3)} runs  ${fmtTokens(r.tokens ?? 0).padStart(6)} tokens  ${fmtTokens(r.cached ?? 0).padStart(6)} cache-read  ~$${(r.cost ?? 0).toFixed(2)}`);
    }
  });

program
  .command("agent [action]")
  .description("connect this computer to an Orys relay on its own (`orys serve --agent` does the same inside the engine); `orys agent login --hub <url>` pairs it with a hub")
  .option("--relay <url>", "relay WebSocket URL, e.g. wss://orys.example.com/_relay/agent")
  .option("--token <token>", "agent token (prefer ORYS_AGENT_TOKEN or the config file)")
  .option("--access-client-id <id>", "Cloudflare Access service token Client ID")
  .option("--access-client-secret <secret>", "Cloudflare Access service token Client Secret (prefer the config file)")
  .option("--target <url>", "the local engine (default http://127.0.0.1:$AIPM_PORT)")
  .option("--save", `store the given values in ${AGENT_CONFIG} (mode 0600) and exit`)
  .option("--hub <url>", "login: the hub to pair with, e.g. https://orys.example.com")
  .option("--name <name>", "login: how this computer is listed on the hub")
  .option("--force", "login: replace an existing relay connection")
  .action(async (action: string | undefined, opts: { relay?: string; token?: string; accessClientId?: string; accessClientSecret?: string; target?: string; save?: boolean; hub?: string; name?: string; force?: boolean }) => {
    if (action === "login") return agentLogin(opts);
    if (action) throw new Error(`unknown action "${action}"; use \`orys agent login --hub <url>\` or no action`);
    const saved = readAgentConfig();
    const config = {
      relay: opts.relay ?? saved.relay,
      token: opts.token ?? saved.token,
      accessClientId: opts.accessClientId ?? saved.accessClientId,
      accessClientSecret: opts.accessClientSecret ?? saved.accessClientSecret,
    };
    if (!config.relay || !config.token) throw new Error(`relay URL and agent token are required (flags, ORYS_RELAY_URL/ORYS_AGENT_TOKEN, or ${AGENT_CONFIG})`);
    if (opts.save) {
      saveAgentConfig(config);
      return console.log(`saved ${AGENT_CONFIG}${config.accessClientId && config.accessClientSecret ? " (with the Access service token)" : ""}`);
    }
    const target = opts.target ?? `http://127.0.0.1:${loadConfig().AIPM_PORT}`;
    const log = (l: string) => console.log(`${ts()} ${l}`);
    const agent = startAgent({ relayUrl: config.relay, token: config.token, target, headers: accessHeaders(config), confirm: macDialogConfirm({ log }), name: `orys-agent@${hostname()}`, log });
    onShutdownSignal(() => agent.stop());
  });

/** `orys agent login --hub <url>`: pair this computer with a hub by code (SPEC §18.5). */
async function agentLogin(opts: { hub?: string; name?: string; force?: boolean }) {
  if (!opts.hub) throw new Error("usage: orys agent login --hub https://…");
  const hub = hubBase(opts.hub);
  const refusal = refuseToReplace(readAgentConfig(), hub, !!opts.force);
  if (refusal) throw new Error(refusal);
  const name = opts.name ?? `${userInfo().username}@${hostname().replace(/\.local$/, "")}`;
  const paired = await pairWithHub({
    hub: hub.toString(),
    name,
    show: (code, url) => {
      console.log(`\nOpen ${url}\nand confirm this code:  ${code}\n`);
      console.log("Waiting for you to confirm (10 minutes)…");
    },
  });
  saveAgentConfig({ relay: paired.relay, token: paired.token });
  console.log(`Paired as "${name}". Saved to ${AGENT_CONFIG} (only you can read it).`);
  console.log("Next: keep Orys running with remote access: bash scripts/launchd.sh install (or Remote → Turn on in the dashboard).");
}

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExecution } from "../src/loops/execution.js";
import { logEvent } from "../src/projects/repo.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { buildServer } from "../src/server/index.js";
import { summarizeRunLog } from "../src/server/runLog.js";
import { setup, worker, type Handler } from "./helpers.js";

async function api(script: Handler[] = [], withScheduler = false) {
  const ctx = await setup(script);
  const app = { ...ctx.deps, db: ctx.db, config: ctx.config };
  const scheduler = withScheduler ? new Scheduler(ctx.deps) : undefined;
  const server = buildServer({ app, scheduler, webDir: null, ssePollMs: 20 });
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const r = await server.inject({ method, url, payload: payload as object | undefined });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  return { ...ctx, server, call };
}

describe("API", () => {
  it("lists projects with progress and serves project detail, phases and docs", async () => {
    const { call } = await api();
    const list = await call("GET", "/api/projects");
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ slug: "demo", status: "executing", tasksTotal: 3, tasksDone: 0, phasesTotal: 2, currentPhase: { idx: 1 } });

    expect((await call("GET", "/api/projects/demo")).body).toMatchObject({ slug: "demo", features: [] });
    const phases = (await call("GET", "/api/projects/demo/phases")).body;
    expect(phases.map((p: { title: string }) => p.title)).toEqual(["One", "Two"]);
    expect(phases[0].tasks[1]).toMatchObject({ key: "p1-b", dependsOnKeys: ["p1-a"], status: "pending" });

    expect((await call("GET", "/api/projects/demo/docs/architecture")).body).toMatchObject({ content: "# Arch" });
    expect((await call("GET", "/api/projects/demo/docs/secrets")).status).toBe(400);
    expect((await call("GET", "/api/projects/nope")).status).toBe(404);

    const decisions = (await call("GET", "/api/projects/demo/decisions")).body;
    expect(decisions.map((d: { target: string; by: string }) => `${d.by}:${d.target}`)).toEqual(["owner:plan", "reviewer:plan", "reviewer:architecture"]);
  });

  it("creates and starts a project; validates input and transitions", async () => {
    const { call } = await api();
    expect((await call("POST", "/api/projects", { slug: "x", name: "X", problem: "short" })).status).toBe(400);
    const created = await call("POST", "/api/projects", {
      slug: "notes", name: "Notes", problem: "A tiny notes app with search.", priority: 4, features: [{ title: "Search", priority: 5 }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "notes", status: "draft", priority: 4 });
    expect((await call("POST", "/api/projects/notes/start")).body.status).toBe("sketching"); // sketch first (SPEC §22.7)
    expect((await call("POST", "/api/projects/notes/start")).status).toBe(409);
  });

  it("inspects a repo for the wizard and creates an existing-repo project, refusing unusable folders", async () => {
    const { call } = await api();
    const { realpathSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { makeOwnerRepo } = await import("./helpers.js");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aipm-api-")));
    const { dir } = await makeOwnerRepo(join(root, "blog"));

    const ins = await call("POST", "/api/repo/inspect", { path: dir });
    expect(ins.body).toMatchObject({ path: dir, name: "blog", isGit: true, branch: "trunk", clean: true, problems: [] });

    const brief = { slug: "blog", name: "Blog", problem: "My personal blog engine.", mode: "existing", repoPath: dir, existing: { currentState: "Posts render; no comments yet." } };
    const created = await call("POST", "/api/projects", brief);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ mode: "existing", baseBranch: "trunk", integrationBranch: "ai-pm/main" });
    expect((await call("POST", "/api/projects/blog/start")).body.status).toBe("mapping");
    expect((await call("POST", "/api/projects", brief)).status).toBe(409); // slug taken

    writeFileSync(join(dir, "draft.md"), "unsaved");
    const refused = await call("POST", "/api/projects", { ...brief, slug: "blog-2" });
    expect(refused.status).toBe(422);
    expect(refused.body.problems.join(" ")).toMatch(/Already used by project "blog"/);
    expect((await call("POST", "/api/projects/blog/merge-base")).status).toBe(409);
  });

  it("patches scheduling settings", async () => {
    const { call } = await api();
    const r = await call("PATCH", "/api/projects/demo", { priority: 5, paused: true, deadline: "2026-12-01" });
    expect(r.body).toMatchObject({ priority: 5, paused: true });
    expect(new Date(r.body.deadline).toISOString().slice(0, 10)).toBe("2026-12-01");
    expect((await call("PATCH", "/api/projects/demo", { deadline: null })).body.deadline).toBeNull();
    expect((await call("PATCH", "/api/projects/demo", { priority: 9 })).status).toBe(400);
    expect((await call("PATCH", "/api/projects/demo", { status: "done" })).status).toBe(400);
  });

  it("retrying a failed task with a note unblocks the project", async () => {
    const { call, deps, project, task } = await api([worker([]), worker([]), worker([])]);
    await runExecution(deps, project.id);
    expect((await call("GET", "/api/projects/demo")).body.status).toBe("blocked");

    const r = await call("POST", `/api/tasks/${task("p1-a").id}/retry`, { message: "Create it in the repo root." });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ status: "rework", attempts: 0 });
    expect(r.body.task.lastFeedback).toContain("Create it in the repo root.");
    expect(r.body.project.status).toBe("executing");
    expect((await call("POST", `/api/tasks/${task("p1-a").id}/retry`, {})).status).toBe(200);
    expect((await call("POST", "/api/projects/demo/unblock", { message: "hi" })).status).toBe(409);
  });

  it("skipping a task is recorded; a skipped task cannot be retried", async () => {
    const { call, task } = await api();
    const r = await call("POST", `/api/tasks/${task("p1-a").id}/skip`, { message: "not needed" });
    expect(r.body.task.status).toBe("skipped");
    const decisions = (await call("GET", "/api/projects/demo/decisions")).body;
    expect(decisions[0]).toMatchObject({ by: "owner", taskKey: "p1-a", feedback: "Skipped by the owner: not needed" });
    expect((await call("POST", `/api/tasks/${task("p1-a").id}/retry`)).status).toBe(409);
    expect((await call("POST", "/api/tasks/nope/skip")).status).toBe(404);
  });

  it("serves runs, usage and status", async () => {
    const { call } = await api([], true);
    const runs = (await call("GET", "/api/runs?project_id=demo")).body;
    expect(runs.map((r: { kind: string }) => r.kind).sort()).toEqual(["architect", "master_review", "master_review", "planner"]);
    expect(runs[0].projectSlug).toBe("demo");
    const log = (await call("GET", `/api/runs/${runs[0].id}/log`)).body;
    expect(log.missing).toBe(true); // the fake client writes no log file
    expect((await call("GET", "/api/runs/nope/log")).status).toBe(404);

    const usage = (await call("GET", "/api/usage?range=7d")).body;
    expect(usage.days).toBe(7);
    expect(usage.rows.find((r: { kind: string }) => r.kind === "planner")).toMatchObject({ projectSlug: "demo", runs: 1 });

    const status = (await call("GET", "/api/status")).body;
    expect(status.limit).toMatchObject({ status: "ok", blocked: false });
    expect(status.scheduler).toMatchObject({ running: true, current: null, queue: [{ slug: "demo" }] });
  });

  it("streams new events over SSE", async () => {
    const { server, db, project } = await api();
    const url = await server.listen({ port: 0, host: "127.0.0.1" });
    const ac = new AbortController();
    try {
      const res = await fetch(`${url}/api/events/stream`, { signal: ac.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const readUntil = async (needle: string) => {
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          buf += dec.decode(value);
        }
      };
      await readUntil("event: hello");
      logEvent(db, project.id, "test_event", { n: 1 });
      await readUntil("test_event");
      const line = buf.split("\n").find((l) => l.includes("test_event"))!;
      expect(JSON.parse(line.replace(/^data: /, ""))).toMatchObject({ type: "test_event", projectSlug: "demo", payload: { n: 1 } });
    } finally {
      ac.abort();
      await server.close();
    }
  });
});

describe("run log summary", () => {
  it("turns a stream-json log into a transcript", () => {
    const s = summarizeRunLog(join(import.meta.dirname, "../fixtures/claude/stream.jsonl"));
    expect(s.missing).toBe(false);
    const kinds = s.entries.map((e) => e.kind);
    expect(kinds[0]).toBe("init");
    expect(kinds).toContain("rate_limit");
    expect(kinds.at(-1)).toBe("result");
  });
});

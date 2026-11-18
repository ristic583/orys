/** Deleting a project: Orys forgets it; its own folder goes only when asked; the owner's repo never. */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "../src/db/index.js";
import { deleteProject, deletionPreview, orysFolder } from "../src/projects/delete.js";
import { remoteDecision, describeConfirm } from "../src/relay/policy.js";
import { buildServer } from "../src/server/index.js";
import { setup } from "./helpers.js";

describe("delete a project", () => {
  it("needs the short name; then removes rows, run logs and, when ticked, the folder Orys made", async () => {
    const { db, config, project } = await setup([], { approve: false });
    const logs = db.select({ logPath: schema.runs.logPath }).from(schema.runs).all().map((r) => r.logPath!);
    expect(logs.length).toBeGreaterThan(0);
    mkdirSync(project.repoPath, { recursive: true });

    const preview = deletionPreview(db, config, project.id);
    expect(preview).toMatchObject({ slug: "demo", orysFolder: { path: project.repoPath, kind: "scratch" }, ownerRepo: null, runs: logs.length });

    expect(() => deleteProject(db, config, project.id, { confirm: "Demo" })).toThrow(/type the project's short name exactly: demo/);
    expect(() => deleteProject(db, config, project.id, { confirm: "demo", busy: () => true })).toThrow(/agent is working/);

    const r = deleteProject(db, config, project.id, { confirm: "demo", removeFolder: true });
    expect(r).toEqual({ deleted: "demo", removedFolder: project.repoPath, removedLogs: logs.length });
    for (const t of [schema.projects, schema.phases, schema.runs, schema.sketches]) expect(db.select().from(t).all()).toHaveLength(0);
    expect(db.select().from(schema.events).all().map((e) => [e.projectId, e.type])).toEqual([[null, "project_deleted"]]);
    expect(logs.some((l) => existsSync(l))).toBe(false);
    expect(existsSync(project.repoPath)).toBe(false);
  });

  it("keeps the folder unless asked", async () => {
    const { db, config, project } = await setup([], { planned: false });
    mkdirSync(project.repoPath, { recursive: true });
    deleteProject(db, config, project.id, { confirm: "demo" });
    expect(existsSync(project.repoPath)).toBe(true);
  });

  it("never treats a folder outside Orys's own directories as its own", () => {
    const config = { AIPM_SANDBOX_DIR: "/home/o/aipm-sandbox", AIPM_PROJECTS_DIR: "/home/o/aipm-projects" };
    expect(orysFolder({ repoPath: "/home/o/code/shop", workspace: "in_place", mode: "existing" }, config)).toBeNull();
    expect(orysFolder({ repoPath: "/home/o/aipm-sandbox", workspace: "sandbox", mode: "existing" }, config)).toBeNull(); // the directory itself
    expect(orysFolder({ repoPath: "/home/o/aipm-sandbox/../code/shop", workspace: "sandbox", mode: "existing" }, config)).toBeNull();
    expect(orysFolder({ repoPath: "/home/o/aipm-sandbox/shop", workspace: "sandbox", mode: "existing" }, config)).toEqual({ path: "/home/o/aipm-sandbox/shop", kind: "sandbox" });
    expect(orysFolder({ repoPath: "/home/o/code/new", workspace: "in_place", mode: "scratch" }, config)).toBeNull();
  });

  it("API: preview, refusal without the name, delete; from the phone it needs a click on the computer", async () => {
    const { db, deps, config, project } = await setup([], { planned: false });
    const server = buildServer({ app: { ...deps, db, config }, webDir: null });
    const call = async (method: "GET" | "DELETE", url: string, payload?: object) => {
      const r = await server.inject({ method, url, payload });
      return { status: r.statusCode, body: r.json() };
    };
    expect((await call("GET", "/api/projects/demo/deletion")).body).toMatchObject({ slug: "demo" });
    expect((await call("DELETE", "/api/projects/demo", { confirm: "nope" })).status).toBe(409);
    expect((await call("DELETE", "/api/projects/demo", { confirm: "demo" })).body).toMatchObject({ deleted: "demo" });
    expect(db.select().from(schema.projects).where(eq(schema.projects.id, project.id)).get()).toBeUndefined();
    expect((await call("GET", "/api/projects/demo")).status).toBe(404);

    expect(remoteDecision("DELETE", "/api/projects/demo")).toEqual({ kind: "confirm", action: "delete_project" });
    expect(remoteDecision("GET", "/api/projects/demo/deletion").kind).toBe("allow");
    expect(describeConfirm("delete_project", "/api/projects/demo", Buffer.from('{"confirm":"demo","removeFolder":true}'))).toBe(
      "Delete project “demo” from Orys, together with the folder Orys made for it.",
    );
  });
});

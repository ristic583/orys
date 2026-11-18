import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb, schema } from "../src/db/index.js";

describe("database", () => {
  it("migrates and round-trips a project → phase → task → run with JSON columns and defaults", () => {
    const db = openDb(":memory:");
    const [project] = db
      .insert(schema.projects)
      .values({ slug: "links", name: "Links", problem: "Shorten URLs", aspects: ["fast"], repoPath: "/tmp/links" })
      .returning()
      .all();
    expect(project).toMatchObject({ status: "draft", profile: "balanced", priority: 3, paused: false, aspects: ["fast"], constraints: [] });

    const [phase] = db.insert(schema.phases).values({ projectId: project!.id, idx: 1, title: "Setup", goal: "Tooling", branch: "phase/1-setup" }).returning().all();
    const [task] = db
      .insert(schema.tasks)
      .values({ phaseId: phase!.id, idx: 1, key: "p1-init", title: "Init", spec: "Set up repo", verifyCommands: ["pnpm test"], acceptance: ["tests run"] })
      .returning()
      .all();
    expect(task).toMatchObject({ status: "pending", attempts: 0, verifyCommands: ["pnpm test"], dependsOn: [] });

    db.insert(schema.runs).values({ projectId: project!.id, taskId: task!.id, kind: "worker", model: "sonnet", inputTokens: 10 }).run();
    const runs = db.select().from(schema.runs).where(eq(schema.runs.taskId, task!.id)).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.startedAt).toBeInstanceOf(Date);
  });

  it("enforces foreign keys and cascades project deletion", () => {
    const db = openDb(":memory:");
    expect(() => db.insert(schema.phases).values({ projectId: "missing", idx: 1, title: "x", goal: "x", branch: "b" }).run()).toThrow(/FOREIGN KEY/);

    const [p] = db.insert(schema.projects).values({ slug: "x", name: "x", problem: "x", repoPath: "/tmp/x" }).returning().all();
    db.insert(schema.phases).values({ projectId: p!.id, idx: 1, title: "x", goal: "x", branch: "b" }).run();
    db.delete(schema.projects).where(eq(schema.projects.id, p!.id)).run();
    expect(db.select().from(schema.phases).all()).toHaveLength(0);
  });

  it("rejects duplicate phase index within a project", () => {
    const db = openDb(":memory:");
    const [p] = db.insert(schema.projects).values({ slug: "y", name: "y", problem: "y", repoPath: "/tmp/y" }).returning().all();
    const phase = { projectId: p!.id, idx: 1, title: "a", goal: "a", branch: "b" };
    db.insert(schema.phases).values(phase).run();
    expect(() => db.insert(schema.phases).values(phase).run()).toThrow(/UNIQUE/);
  });
});

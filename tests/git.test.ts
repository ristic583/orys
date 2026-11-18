import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude/client.js";
import { commitAll, diffForReview, headSha } from "../src/git/index.js";
import { LocalRunner } from "../src/runner/local.js";

describe("diffForReview", () => {
  it("lists lockfiles in the stat but keeps them out of the patch, and truncates long patches", async () => {
    const runner = new LocalRunner(new FakeClaudeClient([]));
    const ws = { slug: "g", repoPath: join(mkdtempSync(join(tmpdir(), "aipm-git-")), "r") };
    await runner.ensureWorkspace(ws);
    const base = await headSha(runner, ws);

    writeFileSync(join(ws.repoPath, "package-lock.json"), Array.from({ length: 3000 }, (_, i) => `"line${i}"`).join("\n"));
    mkdirSync(join(ws.repoPath, "sub"));
    writeFileSync(join(ws.repoPath, "sub", "pnpm-lock.yaml"), "lock: true\n");
    writeFileSync(join(ws.repoPath, "app.ts"), "export const answer = 42;\n");
    await commitAll(runner, ws, "change");

    const d = await diffForReview(runner, ws, base, "HEAD", 100);
    expect(d).toContain("package-lock.json");
    expect(d).toContain("+export const answer = 42;");
    expect(d).not.toContain('"line2999"');
    expect(d).not.toContain("lock: true");

    writeFileSync(join(ws.repoPath, "big.ts"), Array.from({ length: 300 }, (_, i) => `// ${i}`).join("\n"));
    await commitAll(runner, ws, "big");
    expect(await diffForReview(runner, ws, base, "HEAD", 100)).toContain("diff truncated at 100 lines");
  });
});

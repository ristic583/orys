/** Live view: what a running agent is doing, from the tail of its stream-json log. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentActivity } from "../src/server/runLog.js";

const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });

describe("currentActivity", () => {
  it("shows the last tool call in a few words, or the last text, and survives a cut-off first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "aipm-act-"));
    const log = join(dir, "run.jsonl");
    writeFileSync(log, [
      '{"type":"system","subtype":"init","session_id":"s"}',
      line([{ type: "text", text: "Let me look at the dashboard." }]),
      line([{ type: "tool_use", name: "Edit", input: { file_path: "/repo/web/src/Dashboard.tsx", old_string: "a", new_string: "b" } }]),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      "",
    ].join("\n"));
    expect(currentActivity(log)).toEqual({ text: "Edit Dashboard.tsx", at: "tool" });

    writeFileSync(log, `{"type":"assistant","message":{"con` + "\n" + line([{ type: "tool_use", name: "Bash", input: { command: "npm   test\n  -- --run" } }]) + "\n");
    expect(currentActivity(log)?.text).toBe("Bash: npm test -- --run");

    writeFileSync(log, line([{ type: "text", text: "Running the integration suite once.\nMore." }]) + "\n");
    expect(currentActivity(log)).toEqual({ text: "Running the integration suite once.", at: "text" });
    expect(currentActivity(join(dir, "missing.jsonl"))).toBeNull();
  });
});

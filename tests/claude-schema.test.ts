import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeResultSchema, classifyError, parseStream } from "../src/claude/schema.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "claude", name), "utf8");

describe("claude result parsing", () => {
  it("parses a real auth-error result and classifies it as auth", () => {
    const r = ClaudeResultSchema.parse(JSON.parse(fixture("auth-error.json")));
    expect(r.is_error).toBe(true);
    expect(r.session_id).toMatch(/[0-9a-f-]{36}/);
    expect(classifyError(r, { exitCode: 1 })).toBe("auth");
  });

  it("classifies a rejected rate_limit_event as limit, even with a generic error", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, session_id: "s", result: "API error" }),
    ].join("\n");
    const s = parseStream(stdout);
    expect(s.lastRateLimit?.resetsAt).toBe(1_800_000_000);
    expect(classifyError(s.result, { exitCode: 1, lastRateLimit: s.lastRateLimit })).toBe("limit");
  });

  it("falls back to text matching for limit messages", () => {
    const r = ClaudeResultSchema.parse({
      type: "result", subtype: "success", is_error: true, session_id: "s",
      result: "You've hit your limit · resets 3pm (Europe/Belgrade)",
    });
    expect(classifyError(r, { exitCode: 1 })).toBe("limit");
  });

  it("finds the result in json output polluted by stray log lines", () => {
    const stdout = `Client.listTools() called but server does not advertise tools capability\n${fixture("basic.json")}`;
    expect(parseStream(stdout).result?.result).toBe("ok");
  });

  it("parses real stream-json output including a rate_limit_event", () => {
    const s = parseStream(fixture("stream.jsonl"));
    expect(s.result?.is_error).toBe(false);
    expect(s.lastRateLimit?.status).toMatch(/^allowed/);
    expect(typeof s.lastRateLimit?.resetsAt).toBe("number");
  });

  it("treats a clean result as no error", () => {
    const r = ClaudeResultSchema.parse({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok" });
    expect(classifyError(r, { exitCode: 0 })).toBeNull();
  });
});

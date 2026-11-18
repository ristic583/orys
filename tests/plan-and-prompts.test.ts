import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson } from "../src/claude/extractJson.js";
import { PlanSchema, slugify, validatePlan } from "../src/loops/plan.js";
import { OUTCOME, SCOPE } from "./helpers.js";
import { renderPrompt } from "../src/prompts/render.js";

const task = (key: string, depends_on: string[] = [], verify = ["pnpm test"]) => ({
  key, title: key, spec: "do it", acceptance: ["works"], verify_commands: verify, depends_on,
});

describe("validatePlan", () => {
  const plan = (...phases: ReturnType<typeof task>[][]) => PlanSchema.parse({ scope: SCOPE, outcome: OUTCOME, phases: phases.map((tasks, i) => ({ title: `P${i}`, goal: "g", goal_plain: "g", tasks })) });

  it("accepts a valid plan", () => {
    expect(validatePlan(plan([task("a"), task("b", ["a"])], [task("c", ["a", "b"])]))).toEqual([]);
  });

  it("reports unknown deps, forward deps, duplicates and unsafe commands", () => {
    const text = validatePlan(
      plan([task("a"), task("x", ["nope"]), task("w", [], ["pnpm test --watch"]), task("f", ["c"])], [task("a"), task("c")]),
    ).join("\n");
    expect(text).toMatch(/duplicate task key "a"/);
    expect(text).toMatch(/unknown task "nope"/);
    expect(text).toMatch(/"f" \(phase 1\) depends on "c" from a later phase 2/);
    expect(text).toMatch(/interactive or unsafe: "pnpm test --watch"/);
  });

  it("reports dependency cycles with the path", () => {
    expect(validatePlan(plan([task("a", ["c"]), task("b", ["a"]), task("c", ["b"])])).join("\n")).toMatch(/cycle: a → c → b → a/);
  });
});

describe("extractJson", () => {
  const S = z.object({ a: z.number() });
  it("takes the last block, tolerating code fences", () => {
    const text = 'x <<<JSON {"a":1} JSON>>> then\n<<<JSON\n```json\n{"a":2}\n```\nJSON>>>';
    expect(extractJson(text, S)).toEqual({ ok: true, value: { a: 2 } });
  });
  it("explains what is wrong", () => {
    expect(extractJson("no block", S)).toMatchObject({ ok: false, error: expect.stringContaining("no <<<JSON") });
    expect(extractJson("<<<JSON {a:1} JSON>>>", S)).toMatchObject({ ok: false, error: expect.stringContaining("does not parse") });
    expect(extractJson('<<<JSON {"a":"x"} JSON>>>', S)).toMatchObject({ ok: false, error: expect.stringContaining("a:") });
  });
});

describe("renderPrompt", () => {
  const brief = { name: "N", problem: "P", aspects: "-", constraints: "-", features: "-", deadline: "none", profile: "balanced", mode_brief: "", sketch: "" };
  it("renders partials and placeholders", () => {
    const out = renderPrompt("architect", { ...brief, feedback: "" });
    expect(out).toContain("# Project brief: N");
    expect(out).not.toMatch(/\{\{/);
  });
  it("fails loudly on missing or unused values", () => {
    expect(() => renderPrompt("architect", brief)).toThrow(/missing value for \{\{feedback\}\}/);
    expect(() => renderPrompt("architect", { ...brief, feedback: "", extra: "x" })).toThrow(/unused values extra/);
  });
});

describe("slugify", () => {
  it("makes branch-safe names", () => {
    expect(slugify("Project skeleton & Tooling!")).toBe("project-skeleton-tooling");
    expect(slugify("Šifrovanje podataka")).toBe("sifrovanje-podataka");
    expect(slugify("!!!")).toBe("phase");
  });
});

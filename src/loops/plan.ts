import { z } from "zod";
import { EFFORTS, MODELS } from "../core/types.js";
import { OutcomeSchema, ScopeSchema, SIZES, type ProcessChoice } from "../core/outcome.js";

const nonEmpty = z.string().trim().min(1);

export const PlanTaskSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/i, "key must be alphanumeric with dashes"),
  title: nonEmpty,
  spec: nonEmpty,
  acceptance: z.array(nonEmpty).min(1),
  verify_commands: z.array(nonEmpty).min(1),
  depends_on: z.array(z.string()).default([]),
  feature: z.string().nullable().optional(),
  model: z.enum(MODELS).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Agent work: XS ≤ 15 min, S ≤ 30, M ≤ 60, L ≤ 120, XL more. */
  size: z.enum(SIZES).default("S"),
});

export const PlanSchema = z.object({
  /** How big and risky the work really is; master code picks the process from it. */
  scope: ScopeSchema,
  /** What the owner will get, in plain words (shown before they approve). */
  outcome: OutcomeSchema,
  /** The planner's short overview (text before its JSON block); set by master code. */
  overview: z.string().optional(),
  phases: z
    .array(
      z.object({
        title: nonEmpty,
        goal: nonEmpty,
        /** "After this phase you can …", for the owner. */
        goal_plain: z.string().trim().min(1).max(240),
        /** Whether the owner can see something new after this phase. */
        visible: z.boolean().default(false),
        /** Slow or full checks (whole suite, coverage, format) run once at the end of the phase, not after every task. */
        verify_commands: z.array(nonEmpty).optional(),
        tasks: z.array(PlanTaskSchema).min(1),
      }),
    )
    .min(1),
});

export type Plan = z.infer<typeof PlanSchema>;
/** What a planner writes (defaults not applied yet). */
export type PlanInput = z.input<typeof PlanSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/** Commands that would hang or reach outside the sandbox in an unattended gate. */
export const FORBIDDEN_COMMAND = /(--watch\b|\bwatch\b\s*$|\bnpm (start|run dev)\b|\bpnpm (dev|start)\b|\bgit push\b|\bsudo\b)/i;

/**
 * Structural checks the schema cannot express. Returns a list of problems
 * (empty = valid), phrased so they can be sent back to the planner.
 */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  const phaseOf = new Map<string, number>();

  plan.phases.forEach((phase, pi) => {
    for (const t of phase.tasks) {
      if (phaseOf.has(t.key)) problems.push(`duplicate task key "${t.key}"`);
      phaseOf.set(t.key, pi);
    }
  });

  plan.phases.forEach((phase, pi) => {
    for (const c of phase.verify_commands ?? []) {
      if (FORBIDDEN_COMMAND.test(c)) problems.push(`phase ${pi + 1} has a verify command that is interactive or unsafe: "${c}"`);
    }
    for (const t of phase.tasks) {
      for (const d of t.depends_on) {
        const dp = phaseOf.get(d);
        if (dp === undefined) problems.push(`task "${t.key}" depends on unknown task "${d}"`);
        else if (dp > pi) problems.push(`task "${t.key}" (phase ${pi + 1}) depends on "${d}" from a later phase ${dp + 1}`);
        if (d === t.key) problems.push(`task "${t.key}" depends on itself`);
      }
      for (const c of t.verify_commands) {
        if (FORBIDDEN_COMMAND.test(c)) problems.push(`task "${t.key}" has a verify command that is interactive or unsafe: "${c}"`);
      }
    }
  });

  const cycle = findCycle(plan);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" → ")}`);
  return problems;
}

export function findCycle(plan: { phases: { tasks: { key: string; depends_on: string[] }[] }[] }): string[] | null {
  const deps = new Map<string, string[]>();
  for (const p of plan.phases) for (const t of p.tasks) deps.set(t.key, t.depends_on);
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (k: string): string[] | null => {
    const s = state.get(k);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, "visiting");
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(k, "done");
    return null;
  };

  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
}

/**
 * Fit the plan to its process: a quick job becomes one phase (tasks keep
 * their order and dependencies); a standard job may not exceed its phase
 * budget (returned as a problem for the planner).
 */
export function fitToProcess(plan: Plan, process: ProcessChoice): { plan: Plan; problems: string[] } {
  if (plan.phases.length <= process.maxPhases) return { plan, problems: [] };
  if (process.maxPhases === 1) {
    const first = plan.phases[0]!;
    const merged = {
      title: first.title,
      goal: plan.phases.map((p) => p.goal).join("; "),
      goal_plain: plan.phases.at(-1)!.goal_plain,
      visible: plan.phases.some((p) => p.visible),
      verify_commands: [...new Set(plan.phases.flatMap((p) => p.verify_commands ?? []))],
      tasks: plan.phases.flatMap((p) => p.tasks),
    };
    return { plan: { ...plan, phases: [merged] }, problems: [] };
  }
  return { plan, problems: [`this is a ${process.mode} job (${process.scope.size}, ${process.scope.risk} risk): use at most ${process.maxPhases} phases, not ${plan.phases.length}`] };
}

/** Human-readable plan, written to docs/PLAN.md and shown to the reviewer. */
export function renderPlanMarkdown(plan: Plan, title: string): string {
  const out: string[] = [
    `# Implementation plan: ${title}`,
    "",
    `**Scope:** ${plan.scope.size}, ${plan.scope.risk} risk${plan.scope.ui ? ", changes the UI" : ""}. ${plan.scope.reason}`,
    "",
    "## What the owner gets",
    "",
    plan.outcome.summary_plain,
    "",
    ...plan.outcome.you_will_see.map((s) => `- **${s.where}:** ${s.what}`),
    ...(plan.outcome.stays_the_same.length ? ["", "Stays the same:", ...plan.outcome.stays_the_same.map((s) => `- ${s}`)] : []),
    ...(plan.outcome.to_see_it.length ? ["", "To see it:", ...plan.outcome.to_see_it.map((s) => `- ${s}`)] : []),
    "",
  ];
  plan.phases.forEach((p, pi) => {
    out.push(`## Phase ${pi + 1}: ${p.title}`, "", `**Goal:** ${p.goal}`, "", `**For the owner:** ${p.goal_plain}${p.visible ? " _(visible)_" : ""}`, "");
    if (p.verify_commands?.length) out.push("**Phase gate** (runs once, after the last task):", "```sh", ...p.verify_commands, "```", "");
    for (const t of p.tasks) {
      out.push(`### \`${t.key}\` ${t.title}`, "");
      const meta = [
        t.depends_on.length ? `depends on: ${t.depends_on.map((d) => `\`${d}\``).join(", ")}` : null,
        t.feature ? `feature: ${t.feature}` : null,
        t.model ? `model: ${t.model}${t.effort ? `/${t.effort}` : ""}` : null,
        `size: ${t.size}`,
      ].filter(Boolean);
      if (meta.length) out.push(`_${meta.join(" · ")}_`, "");
      out.push(t.spec.trim(), "", "**Acceptance:**", ...t.acceptance.map((a) => `- ${a}`), "");
      out.push("**Verify:**", "```sh", ...t.verify_commands, "```", "");
    }
  });
  return out.join("\n");
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "") || "phase";

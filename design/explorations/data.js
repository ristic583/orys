// Shared mock data for all four design explorations.
// Mirrors the real model (SPEC.md §4, §5, §17) so every variant shows the same content.
window.AIPM = (() => {
  const T = (key, title, status, deps = [], extra = {}) => ({ key, title, status, deps, attempts: 0, max: 3, model: "sonnet", effort: "medium", ...extra });

  const links = {
    slug: "links",
    name: "Links",
    mode: "scratch",
    problem: "Short links with click stats for a small team, self-hosted, no paid services.",
    status: "executing",
    priority: 4,
    profile: "balanced",
    deadline: "2026-11-20",
    usage7d: { cost: 18.4, tokens: 2.1, days: [1.2, 2.8, 3.1, 0.6, 4.2, 3.9, 2.6] },
    flow: [
      { id: "architect", label: "Architect", status: "done", meta: "opus · high · 6m" },
      { id: "arch-review", label: "Review", status: "done", meta: "approved" },
      { id: "planner", label: "Planner", status: "done", meta: "opus · medium · 4m" },
      { id: "plan-review", label: "Review", status: "done", meta: "approved" },
      { id: "owner", label: "You approve plan", status: "done", meta: "Nov 6" },
      { id: "execute", label: "Build", status: "running", meta: "phase 2 of 3" },
    ],
    phases: [
      {
        idx: 1, title: "Foundation", status: "done", branch: "phase/1-foundation",
        tasks: [
          T("p1-setup", "Project skeleton and tooling", "done", [], { attempts: 1 }),
          T("p1-db", "SQLite schema and migrations", "done", ["p1-setup"], { attempts: 1 }),
          T("p1-test", "Test runner and first smoke test", "done", ["p1-setup"], { attempts: 2 }),
          T("p1-ci", "Build and lint gate", "done", ["p1-db", "p1-test"], { attempts: 1, model: "haiku", effort: "low" }),
        ],
      },
      {
        idx: 2, title: "Short links API", status: "active", branch: "phase/2-short-links-api",
        tasks: [
          T("p2-model", "Link model and slug generator", "done", ["p1-ci"], { attempts: 1 }),
          T("p2-redirect", "Redirect endpoint with click logging", "done", ["p2-model"], { attempts: 1 }),
          T("p2-shorten", "POST /shorten with validation", "running", ["p2-model"], { attempts: 1, startedMin: 4 }),
          T("p2-rate", "Rate limit per API key", "rework", ["p2-model"], {
            attempts: 2,
            feedback: "pnpm test failed: 2 tests in rate-limit.spec.ts expect 429 after the 11th request, got 200. The window resets on every request.",
          }),
          T("p2-stats", "Click stats endpoint", "pending", ["p2-shorten", "p2-redirect"]),
        ],
      },
      {
        idx: 3, title: "Dashboard UI", status: "pending", branch: "phase/3-dashboard-ui",
        tasks: [
          T("p3-shell", "App shell and routing", "pending", ["p2-stats"]),
          T("p3-list", "Links table with search", "pending", ["p3-shell"]),
          T("p3-chart", "Clicks per day chart", "pending", ["p3-list"]),
          T("p3-e2e", "End-to-end test of create and open", "pending", ["p3-list", "p3-chart"], { model: "opus", effort: "high" }),
        ],
      },
    ],
    runs: [
      { id: "r41", kind: "worker", task: "p2-shorten", model: "sonnet", effort: "medium", status: "running", dur: "4m", cost: 0.38 },
      { id: "r40", kind: "verify", task: "p2-rate", model: "-", effort: "-", status: "failed", dur: "38s", cost: 0 },
      { id: "r39", kind: "worker", task: "p2-rate", model: "sonnet", effort: "medium", status: "done", dur: "7m", cost: 0.61 },
      { id: "r38", kind: "review", task: "p2-redirect", model: "sonnet", effort: "high", status: "approved", dur: "1m", cost: 0.12 },
      { id: "r37", kind: "worker", task: "p2-redirect", model: "sonnet", effort: "medium", status: "done", dur: "5m", cost: 0.44 },
    ],
    verifications: {
      "p2-rate": [
        { cmd: "pnpm build", exit: 0, ms: 8200 },
        { cmd: "pnpm lint", exit: 0, ms: 3100 },
        { cmd: "pnpm test", exit: 1, ms: 14600, tail: "✗ rate-limit.spec.ts > returns 429 after limit\n  expected 429, received 200\n✗ rate-limit.spec.ts > keeps window across requests\n  expected 1 to be 11\n\nTests  2 failed | 41 passed (43)" },
      ],
    },
  };

  const projects = [
    links,
    {
      slug: "invoice-ocr", name: "Invoice OCR", mode: "existing", status: "awaiting_owner", gate: "approve_plan",
      problem: "Read supplier invoices from email and push totals to the books.",
      priority: 5, profile: "quality", deadline: "2026-11-14",
      done: 0, total: 11, phasesDone: 0, phasesTotal: 3,
      usage7d: { cost: 9.1, tokens: 1.0, days: [0, 0, 0, 2.4, 3.3, 2.1, 1.3] },
      flowAt: 4, attention: "Plan is ready. 3 phases, 11 tasks — approve or edit it.",
    },
    {
      slug: "blog-redesign", name: "Blog redesign", mode: "rework", status: "blocked",
      problem: "New layout for the blog without changing URLs or the RSS feed.",
      priority: 3, profile: "speed", deadline: null,
      done: 6, total: 10, phasesDone: 1, phasesTotal: 2,
      usage7d: { cost: 6.7, tokens: 0.8, days: [1.8, 1.1, 0.9, 1.4, 0.7, 0.8, 0] },
      flowAt: 5, attention: "Reviewer escalated p2-posts: visual snapshots for /posts are missing. Answer to continue.",
    },
    {
      slug: "habit-api", name: "Habit API", mode: "scratch", status: "architecting",
      problem: "Small API for tracking daily habits, used by a mobile app.",
      priority: 2, profile: "cost", deadline: "2026-12-05",
      done: 0, total: 0, phasesDone: 0, phasesTotal: 0,
      usage7d: { cost: 1.2, tokens: 0.2, days: [0, 0, 0, 0, 0, 0.4, 0.8] },
      flowAt: 0, attention: null,
    },
    {
      slug: "cli-weather", name: "Weather CLI", mode: "scratch", status: "done",
      problem: "Terminal weather with a 5-day forecast.",
      priority: 1, profile: "cost", deadline: null,
      done: 8, total: 8, phasesDone: 2, phasesTotal: 2,
      usage7d: { cost: 0.9, tokens: 0.1, days: [0.5, 0.4, 0, 0, 0, 0, 0] },
      flowAt: 6, attention: null,
    },
  ];

  // Derived progress for links
  const all = links.phases.flatMap((p) => p.tasks);
  links.done = all.filter((t) => t.status === "done").length;
  links.total = all.length;
  links.phasesDone = links.phases.filter((p) => p.status === "done").length;
  links.phasesTotal = links.phases.length;
  links.flowAt = 5;
  links.attention = null;

  return {
    today: "2026-11-09",
    limit: { status: "ok", utilization: 0.62, resetAt: "18:40" },
    current: { project: "links", task: "p2-shorten", title: "POST /shorten with validation", kind: "worker", model: "sonnet", startedMin: 4 },
    projects,
    project: links,
    flowSteps: ["Architect", "Review", "Plan", "Review", "You approve", "Build", "Done"],
    events: [
      { at: "14:12", project: "links", text: "Started p2-shorten (attempt 1)", kind: "run" },
      { at: "14:11", project: "links", text: "p2-rate sent back: 2 failing tests in rate-limit.spec.ts", kind: "rework" },
      { at: "13:58", project: "links", text: "Reviewer approved p2-redirect", kind: "approve" },
      { at: "13:20", project: "invoice-ocr", text: "Plan ready, waiting for you", kind: "owner" },
      { at: "12:47", project: "blog-redesign", text: "Blocked: reviewer escalated p2-posts", kind: "blocked" },
      { at: "11:05", project: "habit-api", text: "Architect started (sonnet · high)", kind: "run" },
    ],
    modes: {
      scratch: {
        label: "From scratch", hint: "A new idea and an empty repo.", first: "Architect",
        steps: ["Name", "Problem", "Key features", "Constraints", "What matters for quality", "Profile, priority, deadline"],
      },
      existing: {
        label: "Continue a project", hint: "Existing code that should keep moving.", first: "Mapper",
        steps: ["Repository", "What it does today", "What's next or what hurts", "Don't touch", "How it's checked", "Profile, priority, deadline"],
      },
      rework: {
        label: "Rework", hint: "Redesign, refactor or add tests to a nearly done project.", first: "Mapper (baseline)",
        steps: ["Repository", "Kind of work", "Success criteria", "Frozen behaviour", "Scope", "Constraints", "Profile, priority, deadline"],
      },
    },
    stepHelp: {
      "Name": { q: "What should we call it?", kind: "text", value: "Links", hint: "Used for the folder and branch names." },
      "Problem": { q: "What should exist, and for whom?", kind: "area", value: "Short links with click stats for a small team.", hint: "Two or three sentences is enough. The architect asks if something is unclear." },
      "Key features": { q: "Which features matter, in order?", kind: "list", items: ["Shorten a URL", "Redirect and count clicks", "Stats per link"], hint: "Drag to reorder. Top is built first." },
      "Constraints": { q: "Anything the build must respect?", kind: "chips", items: ["Self-hosted", "No paid services", "SQLite", "TypeScript"], hint: "Pick or type your own." },
      "What matters for quality": { q: "What should reviewers be strict about?", kind: "chips", items: ["Tests for every endpoint", "Fast redirects", "Simple to deploy"], hint: "Reviewers check every task against these." },
      "Profile, priority, deadline": { q: "How should it run?", kind: "profile", hint: "Balanced uses opus to plan and sonnet to build." },
      "Repository": { q: "Where is the code?", kind: "repo", value: "~/code/invoice-ocr", hint: "Agents work on their own branches. Your branch only changes when you merge." },
      "What it does today": { q: "What does it do, and how far along is it?", kind: "area", value: "Parses PDF invoices from one supplier. No email import yet.", hint: "The mapper reads the code too; this tells it what you think matters." },
      "What's next or what hurts": { q: "What's next, or what hurts? (optional)", kind: "area", value: "", hint: "Leave empty and the mapper will suggest." },
      "Don't touch": { q: "Which parts should agents leave alone?", kind: "chips", items: ["src/legacy/", "migrations/"], hint: "Paths or areas." },
      "How it's checked": { q: "How do we know a change works?", kind: "chips", items: ["pnpm test", "pnpm build", "Let the mapper find out"], hint: "These commands decide if a task passed." },
      "Kind of work": { q: "What kind of work is it?", kind: "chips", items: ["UI redesign", "Refactor", "Tests and coverage", "Performance", "Security", "Dependency upgrade"], hint: "Pick one or more." },
      "Success criteria": { q: "How will we know it's done?", kind: "list", items: ["Coverage at least 80%", "p95 under 200 ms"], hint: "Measurable is better." },
      "Frozen behaviour": { q: "Must the public behaviour stay the same?", kind: "toggle", hint: "If yes, characterization tests are written first." },
      "Scope": { q: "Whole repository or some folders?", kind: "chips", items: ["Whole repo", "src/web/", "src/api/"], hint: "" },
    },
    repoCheck: [
      { ok: true, text: "Git repository root" },
      { ok: true, text: "On branch main, 214 commits" },
      { ok: true, text: "Working tree is clean" },
      { ok: true, text: "Detected: TypeScript, pnpm, Vitest, GitHub Actions" },
      { ok: true, text: "Suggested checks: pnpm test, pnpm build, pnpm lint" },
    ],
    statusLabel: {
      done: "Done", running: "Running", rework: "Needs rework", pending: "Waiting", ready: "Ready",
      verifying: "Checking", reviewing: "In review", failed: "Failed", skipped: "Skipped", active: "Active",
      executing: "Building", awaiting_owner: "Waiting for you", blocked: "Blocked", architecting: "Architecting",
      planning: "Planning", mapping: "Mapping", draft: "Draft",
    },
  };
})();

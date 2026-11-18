/**
 * Records a running Orys for the static demo (`pnpm build:demo`, web/src/demo/install.ts).
 *
 *   pnpm demo:snapshot [http://127.0.0.1:4317]
 *
 * Fetches every API response the dashboard asks for, for every project, task and run, plus the images it shows
 * (sketches, design directions, screenshots), and writes them to web/demo-public/. Local paths and the user name are
 * replaced (DEMO_REPLACE="from=to,from=to" adds more), and the write is refused if anything private is left.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const root = join(import.meta.dirname, "..", "web");
const out = join(root, "demo-public");

const replacements: [string, string][] = [
  [homedir(), "/home/demo"],
  [userInfo().username, "demo"],
  ...(process.env.DEMO_REPLACE ?? "")
    .split(",")
    .filter((p) => p.includes("="))
    .map((p) => p.split("=", 2) as [string, string]),
];
const clean = (text: string) => replacements.reduce((t, [from, to]) => t.split(from).join(to), text);

const routes: Record<string, string> = {};
let n = 0;

async function get(path: string): Promise<unknown> {
  const res = await fetch(base + path);
  if (!res.ok) {
    console.warn(`skip ${path}: HTTP ${res.status}`);
    return null;
  }
  let text = clean(await res.text());
  if (path === "/api/status") {
    // The recording is a still picture: no agent is working in it.
    const status = JSON.parse(text) as { scheduler?: { current: unknown; jobs?: unknown[] } | null };
    if (status.scheduler) status.scheduler = { ...status.scheduler, current: null, jobs: [] };
    text = JSON.stringify(status);
  }
  if (path === "/api/remote") {
    // Never the recording machine's own remote-access setup (relay host, tokens).
    text = JSON.stringify({ available: false, via: "local" });
  }
  const file = `r/${(n++).toString(36)}.json`;
  mkdirSync(join(out, "demo", "r"), { recursive: true });
  writeFileSync(join(out, "demo", file), text);
  routes[path] = file;
  return JSON.parse(text) as unknown;
}

async function asset(path: string): Promise<void> {
  const res = await fetch(base + path);
  if (!res.ok) return console.warn(`skip asset ${path}: HTTP ${res.status}`);
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
}

/** Every string value in a JSON tree that looks like an image file name. */
function images(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^[\w.-]+\.(png|jpe?g|webp|gif|svg)$/i.test(value)) found.add(value);
  else if (Array.isArray(value)) value.forEach((v) => images(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => images(v, found));
  return found;
}

type P = { id: string; slug: string };
type Phase = { tasks: { id: string }[] };
type Run = { id: string };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "public", "favicon.svg"), join(out, "favicon.svg"));

for (const path of ["/api/status", "/api/remote", "/api/sessions", "/api/metrics", "/api/events?limit=30", "/api/runs?limit=500"]) await get(path);
for (const days of [7, 14, 28, 30, 60]) await get(`/api/usage?range=${days}d`);
await get("/api/repo/discover");

const projects = ((await get("/api/projects")) as P[] | null) ?? [];
for (const p of projects) {
  for (const id of new Set([p.id, p.slug])) {
    await get(`/api/projects/${id}`);
    const phases = ((await get(`/api/projects/${id}/phases`)) as Phase[] | null) ?? [];
    for (const what of ["decisions", "events", "map", "outcome", "sketch", "deletion"]) await get(`/api/projects/${id}/${what}`);
    for (const doc of ["architecture", "plan", "state", "goals"]) await get(`/api/projects/${id}/docs/${doc}`);
    if (id !== p.id) continue;
    await get(`/api/runs?project_id=${p.id}`);
    for (const t of phases.flatMap((ph) => ph.tasks)) {
      await get(`/api/tasks/${t.id}/verifications`);
      await get(`/api/runs?task_id=${t.id}`);
    }
    // Images the project page shows straight from the API.
    const sketch = routes[`/api/projects/${p.id}/sketch`];
    const outcome = routes[`/api/projects/${p.id}/outcome`];
    const sketchView = sketch ? ((await (await fetch(`${base}/api/projects/${p.id}/sketch`)).json()) as { versions?: { version: number }[] }) : null;
    for (const v of sketchView?.versions ?? []) for (const f of images(v)) await asset(`/api/projects/${p.id}/sketch/files/${v.version}/${f}`);
    if (outcome) {
      const files = images(await (await fetch(`${base}/api/projects/${p.id}/outcome`)).json());
      for (const f of files) {
        await asset(`/api/projects/${p.id}/designs/${f}`);
        await asset(`/api/projects/${p.id}/screens/${f}`);
      }
    }
  }
}

const runs = ((await get("/api/runs?limit=500")) as Run[] | null) ?? [];
for (const r of runs) await get(`/api/runs/${r.id}/log`);

// Nothing private may be left in the recording.
const leftovers = [homedir(), userInfo().username, ...(process.env.DEMO_FORBID ?? "").split(",")].filter((s) => s.length > 2);
for (const f of Object.values(routes)) {
  const text = readFileSync(join(out, "demo", f), "utf8");
  const hit = leftovers.find((s) => text.includes(s));
  if (hit) throw new Error(`demo/${f} still contains "${hit}"`);
}

writeFileSync(join(out, "demo", "index.json"), JSON.stringify({ capturedAt: new Date().toISOString(), routes }, null, 1));
console.log(`Recorded ${Object.keys(routes).length} responses into ${out}`);

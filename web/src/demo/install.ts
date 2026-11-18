/**
 * Static demo: the real dashboard on recorded data, with no Orys engine behind it.
 *
 * Built with `pnpm build:demo` (VITE_ORYS_DEMO=1). `scripts/demo-snapshot.ts` records every API response the dashboard
 * asks for from a running Orys into `web/public/demo/`; here `fetch` answers `/api/*` from that recording and the live
 * event stream stays quiet. Anything that would change state answers 403 with a short explanation, so the UI shows it as
 * an ordinary error. Timestamps are moved forward by the time since the recording, so "2 hours ago" stays true.
 */
type Index = { capturedAt: string; routes: Record<string, string> };

export const DEMO_REPO_URL = "https://github.com/ristic583/orys";
export const READ_ONLY_MESSAGE = "This is a read-only demo with recorded data. Run Orys locally to start projects of your own.";

const ISO = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g;
const DAY = /"day":"(\d{4}-\d{2}-\d{2})"/g;

function shift(text: string, offsetMs: number): string {
  const dayOffset = Math.round(offsetMs / 86_400_000);
  return text
    .replace(ISO, (_, iso: string) => `"${new Date(Date.parse(iso) + offsetMs).toISOString()}"`)
    .replace(DAY, (_, day: string) => {
      const d = new Date(`${day}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + dayOffset);
      return `"day":"${d.toISOString().slice(0, 10)}"`;
    });
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** A stand-in for the server's event stream: connects, then never says anything. */
class QuietEventSource extends EventTarget {
  readonly url: string;
  readyState = 1;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onopen: ((ev: Event) => unknown) | null = null;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    setTimeout(() => this.dispatchEvent(new MessageEvent("hello", { data: "{}" })), 0);
  }
  close() {
    this.readyState = 2;
  }
}

export async function installDemo(): Promise<void> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const index = (await (await fetch(`${base}/demo/index.json`)).json()) as Index;
  const offsetMs = Math.max(0, Date.now() - Date.parse(index.capturedAt));
  const cache = new Map<string, Promise<string>>();
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return json(JSON.stringify({ error: READ_ONLY_MESSAGE }), 403);

    const key = url.pathname + url.search;
    const file = index.routes[key];
    if (!file) return json(JSON.stringify({ error: "Not part of the demo recording." }), 404);
    let body = cache.get(file);
    if (!body) {
      body = realFetch(`${base}/demo/${file}`).then((r) => r.text()).then((t) => shift(t, offsetMs));
      cache.set(file, body);
    }
    return json(await body);
  };
  (window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;
}

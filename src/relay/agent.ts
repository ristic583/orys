/**
 * Orys agent (SPEC §18): runs on the owner's computer, dials out to the relay
 * and replays each request against the local engine (`orys serve`). It never
 * talks to anything but `target`, and never forwards cookies or auth headers.
 *
 * Every request is checked against the remote policy first (SPEC §18.3):
 * unlisted routes are refused, and merging or creating a project waits for a
 * click on this computer.
 */
import { WebSocket } from "ws";
import { describeConfirm, remoteDecision, type ProjectLabel } from "./policy.js";
import type { Confirm } from "./confirm.js";
import { FORWARDED_REQUEST_HEADERS, DROPPED_RESPONSE_HEADERS, PROTOCOL_VERSION, REMOTE_MARKER_HEADER, type AgentToRelay, type RelayToAgent } from "./protocol.js";

export type AgentOptions = {
  /** e.g. wss://orys.example.com/_relay/agent */
  relayUrl: string;
  token: string;
  /** The local engine, e.g. http://127.0.0.1:4317 */
  target: string;
  /** Extra headers on the connection to the relay, e.g. the Cloudflare Access service token. */
  headers?: Record<string, string>;
  /** Asks the owner on this computer; without it, actions that need a confirmation are refused. */
  confirm?: Confirm;
  name?: string;
  log?: (line: string) => void;
};

export type AgentState = "connecting" | "connected" | "stopped";
export type AgentStatus = { state: AgentState; since: number; lastError: string | null };
export type AgentHandle = { stop: () => void; connected: () => boolean; status: () => AgentStatus };

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

export const REFUSED_REMOTE = "Not available from the hosted dashboard. Do this on your computer.";
export const NOT_CONFIRMED = "Not confirmed on your computer. Orys asks there before merging into main, creating or deleting a project, and nobody allowed it.";

export function startAgent(opts: AgentOptions): AgentHandle {
  const log = opts.log ?? ((l: string) => console.log(`${new Date().toISOString()} ${l}`));
  const target = new URL(opts.target);
  const allowedHeaders = new Set(FORWARDED_REQUEST_HEADERS);
  const droppedHeaders = new Set(DROPPED_RESPONSE_HEADERS);
  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = MIN_BACKOFF;
  let retry: NodeJS.Timeout | undefined;
  let isOpen = false;
  let state: AgentState = "connecting";
  let since = Date.now();
  let lastError: string | null = null;
  const setState = (s: AgentState) => {
    if (s !== state) since = Date.now();
    state = s;
  };
  const inflight = new Map<number, AbortController>();

  const send = (frame: AgentToRelay) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const reply = (id: number, status: number, body: unknown) => {
    send({ t: "head", id, status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    send({ t: "chunk", id, data: Buffer.from(JSON.stringify(body)).toString("base64") });
    send({ t: "end", id });
  };

  /** The name and short name for the dialog (the URL carries only the id); the id itself if the lookup fails. */
  async function projectLabel(path: string): Promise<ProjectLabel | undefined> {
    const id = path.split("/")[3];
    if (!id) return undefined;
    try {
      const r = await fetch(new URL(`/api/projects/${id}`, target), { signal: AbortSignal.timeout(3_000) });
      const p = (await r.json()) as { name?: unknown; slug?: unknown };
      return r.ok && typeof p.name === "string" && typeof p.slug === "string" ? { name: p.name.slice(0, 80), slug: p.slug } : undefined;
    } catch {
      return undefined;
    }
  }

  async function forward(frame: Extract<RelayToAgent, { t: "req" }>) {
    // Only a path may come from the relay; host and port are always the local engine's.
    const url = new URL(frame.url, target);
    if (url.origin !== target.origin) {
      send({ t: "error", id: frame.id, message: "refused: not the local engine" });
      return;
    }
    const body = frame.body ? Buffer.from(frame.body, "base64") : undefined;
    const ctrl = new AbortController();
    inflight.set(frame.id, ctrl);
    try {
      const decision = remoteDecision(frame.method, url.pathname);
      if (decision.kind === "deny") {
        log(`refused ${frame.method} ${url.pathname} (not allowed from the hosted dashboard)`);
        return reply(frame.id, 403, { error: REFUSED_REMOTE });
      }
      if (decision.kind === "confirm") {
        const detail = describeConfirm(decision.action, url.pathname, body, decision.action === "new_project" ? undefined : await projectLabel(url.pathname));
        log(`asking on this computer: ${detail}`);
        const ok = opts.confirm ? await opts.confirm({ title: "Orys: allow this?", detail }) : false;
        if (ctrl.signal.aborted) return;
        log(`${ok ? "allowed" : "not allowed"}: ${detail}`);
        if (!ok) return reply(frame.id, 403, { error: NOT_CONFIRMED });
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(frame.headers)) if (allowedHeaders.has(k.toLowerCase())) headers[k] = v;
      headers[REMOTE_MARKER_HEADER] = "1";
      const res = await fetch(url, { method: frame.method, headers, body, signal: ctrl.signal, redirect: "manual" });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!droppedHeaders.has(k)) out[k] = v;
      });
      send({ t: "head", id: frame.id, status: res.status, headers: out });
      if (res.body) {
        for await (const chunk of res.body) {
          if (ctrl.signal.aborted) break;
          send({ t: "chunk", id: frame.id, data: Buffer.from(chunk).toString("base64") });
        }
      }
      send({ t: "end", id: frame.id });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const msg = (e as Error).cause ? `${(e as Error).message}: ${String((e as Error).cause)}` : (e as Error).message;
        send({ t: "error", id: frame.id, message: `local engine unreachable (${msg})` });
      }
    } finally {
      inflight.delete(frame.id);
    }
  }

  function connect() {
    if (stopped) return;
    setState("connecting");
    let refused = false;
    const sock = new WebSocket(opts.relayUrl, { headers: { ...opts.headers, authorization: `Bearer ${opts.token}` }, handshakeTimeout: 15_000 });
    ws = sock;
    sock.on("open", () => {
      isOpen = true;
      backoff = MIN_BACKOFF;
      lastError = null;
      setState("connected");
      log(`connected to ${opts.relayUrl} → forwarding to ${target.origin}`);
      send({ t: "hello", agent: opts.name ?? "orys-agent", version: PROTOCOL_VERSION });
    });
    sock.on("message", (data) => {
      let frame: RelayToAgent;
      try {
        frame = JSON.parse(String(data)) as RelayToAgent;
      } catch {
        return;
      }
      if (frame.t === "req") void forward(frame);
      else if (frame.t === "cancel") inflight.get(frame.id)?.abort();
    });
    sock.on("unexpected-response", (_req, res) => {
      const hint = res.statusCode === 401 ? ": check the agent token" : res.statusCode === 403 ? ": check the Cloudflare Access service token" : "";
      refused = true;
      lastError = `relay refused the connection (HTTP ${res.statusCode})${hint}`;
      log(lastError);
      sock.terminate();
    });
    sock.on("error", (e) => {
      if (!isOpen && !refused) {
        lastError = `cannot reach relay: ${e.message}`;
        log(lastError);
      }
    });
    sock.on("close", (code) => {
      const wasOpen = isOpen;
      isOpen = false;
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      if (stopped) return;
      if (wasOpen) log(`disconnected (${code}); reconnecting`);
      setState("connecting");
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    });
  }

  connect();
  return {
    connected: () => isOpen,
    status: () => ({ state, since, lastError }),
    stop: () => {
      stopped = true;
      setState("stopped");
      if (retry) clearTimeout(retry);
      for (const c of inflight.values()) c.abort();
      ws?.close(1000, "agent stopping");
    },
  };
}

/**
 * `orys agent login --hub <url>` (SPEC §18.5): pair this computer with an Orys hub by code,
 * like `gh auth login`. The computer gets its own device token; the person approves it in
 * their signed-in browser. Nothing secret is typed or shown.
 */
import type { AgentConfig } from "./remote.js";

export class PairingError extends Error {}

/** https only; plain http only to this machine (tests, development). */
export function hubBase(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PairingError(`not a URL: ${raw}`);
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new PairingError("the hub address must start with https://");
  return new URL(u.origin);
}

/**
 * The owner's own computer stays on the private relay: replacing a relay connection that uses a
 * Cloudflare Access service token (or any other relay) needs `force`.
 */
export function refuseToReplace(current: AgentConfig, hub: URL, force: boolean): string | null {
  if (force || !current.relay) return null;
  let host = current.relay;
  try {
    const u = new URL(current.relay);
    if (u.host === hub.host && u.pathname === "/_hub/agent") return null; // re-pairing with the same hub
    host = u.host;
  } catch {
    // shown as is
  }
  return `This computer is connected to ${host}${current.accessClientId ? " (a private relay behind Cloudflare Access)" : ""}. Logging in to ${hub.host} would replace that connection. Run again with --force if that is what you want.`;
}

type Start = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number };

export async function pairWithHub(opts: {
  hub: string;
  name: string;
  /** Shows the code and where to enter it. */
  show: (code: string, url: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ relay: string; token: string }> {
  const base = hubBase(opts.hub);
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const post = async (path: string, body: unknown) => {
    const r = await f(new URL(path, base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, json };
  };

  const started = await post("/_hub/api/pair/start", { name: opts.name });
  if (started.status !== 200) throw new PairingError(started.status === 429 ? "too many pairing attempts from here; try again in an hour" : `the hub refused to start pairing (HTTP ${started.status})`);
  const s = started.json as unknown as Start;
  opts.show(s.user_code, s.verification_uri_complete ?? s.verification_uri);

  let interval = Math.max(5, Number(s.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(s.expires_in) || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await post("/_hub/api/pair/poll", { device_code: s.device_code });
    const status = r.json.status;
    if (status === "approved" && typeof r.json.token === "string" && typeof r.json.agent_url === "string") {
      const agentUrl = new URL(r.json.agent_url);
      // The token goes only back to the hub we started with.
      if (agentUrl.host !== base.host || agentUrl.pathname !== "/_hub/agent") throw new PairingError("the hub answered with an unexpected agent address; not saved");
      return { relay: agentUrl.toString(), token: r.json.token };
    }
    if (status === "slow_down") interval += 5000;
    else if (status !== "pending") throw new PairingError("the code expired or was already used; run `orys agent login` again");
  }
  throw new PairingError("nobody confirmed the code within 10 minutes; run `orys agent login` again");
}

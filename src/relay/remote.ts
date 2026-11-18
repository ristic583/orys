/**
 * Remote access inside `orys serve` (SPEC §18.3): the agent runs in the engine's own
 * process, so launchd keeps one service alive, and the dashboard can turn it on and off.
 * The owner's switch survives restarts (data/remote.json).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { startAgent, type AgentHandle, type AgentOptions } from "./agent.js";
import type { Confirm } from "./confirm.js";

export const AGENT_CONFIG = join(homedir(), ".config", "orys", "agent.json");

/** ~/.config/orys/agent.json (mode 0600), overridable by environment variables. */
export type AgentConfig = { relay?: string; token?: string; accessClientId?: string; accessClientSecret?: string };

export function readAgentConfig(path = AGENT_CONFIG, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AgentConfig) : {};
  return {
    relay: env.ORYS_RELAY_URL || saved.relay,
    token: env.ORYS_AGENT_TOKEN || saved.token,
    accessClientId: env.ORYS_ACCESS_CLIENT_ID || saved.accessClientId,
    accessClientSecret: env.ORYS_ACCESS_CLIENT_SECRET || saved.accessClientSecret,
  };
}

export function saveAgentConfig(config: AgentConfig, path = AGENT_CONFIG): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The Cloudflare Access service token: Cloudflare swaps these headers for a signed token the relay checks. */
export function accessHeaders(c: AgentConfig): Record<string, string> {
  return c.accessClientId && c.accessClientSecret ? { "cf-access-client-id": c.accessClientId, "cf-access-client-secret": c.accessClientSecret } : {};
}

export type RemoteState = "not_configured" | "off" | "connecting" | "connected";
export type RemoteStatus = {
  available: true;
  /** Relay URL and agent token are set. */
  configured: boolean;
  /** The owner's switch. */
  enabled: boolean;
  state: RemoteState;
  since: number | null;
  lastError: string | null;
  relayHost: string | null;
  /** A Cloudflare Access service token is set for the agent. */
  serviceToken: boolean;
  /** Connected to an Orys hub (shared, invite-only) rather than a private relay. */
  hub: boolean;
};

export type RemoteAccessOptions = {
  /** Where the owner's on/off switch is kept, e.g. data/remote.json. */
  statePath: string;
  /** The local engine, e.g. http://127.0.0.1:4317 */
  target: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  confirm?: Confirm;
  log?: (line: string) => void;
  /** Tests replace the agent. */
  start?: (opts: AgentOptions) => AgentHandle;
};

export class RemoteAccess {
  private agent: AgentHandle | undefined;
  private stoppedAt = Date.now();

  constructor(private readonly o: RemoteAccessOptions) {}

  private config(): AgentConfig {
    try {
      return readAgentConfig(this.o.configPath, this.o.env);
    } catch (e) {
      this.o.log?.(`remote access: cannot read the agent config (${(e as Error).message})`);
      return {};
    }
  }

  /** On unless the owner turned it off. */
  get enabled(): boolean {
    try {
      return (JSON.parse(readFileSync(this.o.statePath, "utf8")) as { enabled?: boolean }).enabled !== false;
    } catch {
      return true;
    }
  }

  private setEnabled(enabled: boolean) {
    mkdirSync(dirname(this.o.statePath), { recursive: true });
    writeFileSync(this.o.statePath, JSON.stringify({ enabled, at: new Date().toISOString() }) + "\n");
  }

  /** At startup (`serve --agent`): connect unless the owner turned remote access off. */
  boot(): void {
    if (this.enabled) this.connect();
    else this.o.log?.("remote access is off (turned off in the dashboard)");
  }

  enable(): RemoteStatus {
    this.setEnabled(true);
    this.connect();
    return this.status();
  }

  /** `delayMs`: when the request came through the relay, let its answer reach the phone first. */
  disable(delayMs = 0): RemoteStatus {
    this.setEnabled(false);
    if (delayMs > 0) setTimeout(() => this.stop(), delayMs).unref();
    else this.stop();
    return { ...this.status(), state: "off" };
  }

  /** Disconnect without changing the owner's switch (shutdown). */
  stop(): void {
    if (!this.agent) return;
    this.agent.stop();
    this.agent = undefined;
    this.stoppedAt = Date.now();
    this.o.log?.("remote access: disconnected");
  }

  private connect() {
    if (this.agent) return;
    const c = this.config();
    if (!c.relay || !c.token) {
      this.o.log?.(`remote access: not configured (run \`orys agent --save --relay … --token …\`)`);
      return;
    }
    const start = this.o.start ?? startAgent;
    this.agent = start({
      relayUrl: c.relay,
      token: c.token,
      target: this.o.target,
      headers: accessHeaders(c),
      confirm: this.o.confirm,
      name: `orys@${hostname()}`,
      log: this.o.log,
    });
  }

  status(): RemoteStatus {
    const c = this.config();
    const configured = !!(c.relay && c.token);
    let relayHost: string | null = null;
    let hub = false;
    try {
      const u = c.relay ? new URL(c.relay) : null;
      relayHost = u?.host ?? null;
      hub = u?.pathname === "/_hub/agent";
    } catch {
      relayHost = null;
    }
    const base = { available: true as const, configured, enabled: this.enabled, relayHost, hub, serviceToken: !!(c.accessClientId && c.accessClientSecret) };
    if (!configured) return { ...base, state: "not_configured", since: null, lastError: null };
    if (!this.agent) return { ...base, state: "off", since: this.stoppedAt, lastError: null };
    const s = this.agent.status();
    return { ...base, state: s.state === "stopped" ? "off" : s.state, since: s.since, lastError: s.lastError };
  }
}

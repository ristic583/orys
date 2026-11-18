import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_CONFIRMED, REFUSED_REMOTE, startAgent, type AgentHandle, type AgentOptions } from "../src/relay/agent.js";
import type { Confirm } from "../src/relay/confirm.js";
import { describeConfirm, remoteDecision } from "../src/relay/policy.js";
import { RemoteAccess } from "../src/relay/remote.js";
import { createRelay, hashPassword, type AccessJwk, type AccessOptions, type RelayOptions } from "../src/relay/server.js";
import { buildServer } from "../src/server/index.js";
import { setup } from "./helpers.js";

const PASSWORD = "correct horse";
const TOKEN = "agent-token-123";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A stand-in for `orys serve`: echoes requests, plus an SSE endpoint and a mockup with its own CSP. */
async function fakeEngine() {
  const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/api/events/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: one\n\n");
        setTimeout(() => res.write("data: two\n\n"), 30);
        return;
      }
      if (req.method === "GET" && req.url === "/api/projects/01PROJ") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "01PROJ", name: "Mali servis", slug: "mali-servis" }));
      }
      if (req.url?.includes("/designs/")) {
        res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'none'; sandbox" });
        return res.end("<h1>mockup</h1>");
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "leak=1" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  const port = await listen(server);
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { port, seen };
}

type SetupOpts = { withAgent?: boolean; token?: string; agent?: Partial<AgentOptions>; relay?: Partial<RelayOptions> };

async function setupRelay(o: SetupOpts = {}) {
  const engine = await fakeEngine();
  const relay = createRelay({ passwordHash: await hashPassword(PASSWORD), secret: "s3cret", agentToken: TOKEN, secureCookie: false, log: () => {}, ...o.relay });
  const port = await listen(relay.server);
  cleanups.push(() => relay.close());
  const base = `http://127.0.0.1:${port}`;
  let agent: AgentHandle | undefined;
  if (o.withAgent ?? true) {
    agent = startAgent({ relayUrl: `ws://127.0.0.1:${port}/_relay/agent`, token: o.token ?? TOKEN, target: `http://127.0.0.1:${engine.port}`, log: () => {}, ...o.agent });
    cleanups.push(() => agent!.stop());
  }
  const login = async (password = PASSWORD, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/_relay/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
      body: new URLSearchParams({ password }).toString(),
      redirect: "manual",
    });
    return { status: r.status, location: r.headers.get("location"), cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  return { base, relay, agent, engine, login };
}

describe("relay + agent (SPEC §18)", () => {
  it("requires a login: html gets a redirect, api calls get 401", async () => {
    const { base } = await setupRelay();
    const page = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/_relay/login");
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  });

  it("rejects a wrong password and a forged cookie", async () => {
    const { base, login } = await setupRelay();
    const bad = await login("nope");
    expect(bad.location).toBe("/_relay/login?failed");
    expect(bad.cookie).toBe("");
    const forged = await fetch(`${base}/api/projects`, { headers: { cookie: `orys_session=${Date.now() + 1e9}.AAAA` } });
    expect(forged.status).toBe(401);
  });

  it("forwards requests to the local engine, without cookies, marked as remote, and streams SSE", async () => {
    const { base, relay, engine, login } = await setupRelay();
    await until(relay.agentConnected);
    const { cookie } = await login();
    expect(cookie).toMatch(/^orys_session=/);

    const get = await fetch(`${base}/api/projects?x=1`, { headers: { cookie, accept: "application/json" } });
    expect(get.status).toBe(200);
    expect(get.headers.get("set-cookie")).toBeNull();
    expect(await get.json()).toEqual({ method: "GET", url: "/api/projects?x=1", body: "" });

    const post = await fetch(`${base}/api/probe`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: '{"a":1}' });
    expect(await post.json()).toEqual({ method: "POST", url: "/api/probe", body: '{"a":1}' });
    const last = engine.seen.at(-1)!;
    expect(last.headers.cookie).toBeUndefined();
    expect(last.headers["content-type"]).toBe("application/json");
    expect(last.headers["x-orys-remote"]).toBe("1");

    const sse = await fetch(`${base}/api/events/stream`, { headers: { cookie } });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    let text = "";
    while (!text.includes("two")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("data: one");
    await reader.cancel();
  });

  it("blocks cross-site writes", async () => {
    const { base, relay, login } = await setupRelay();
    await until(relay.agentConnected);
    const { cookie } = await login();
    const r = await fetch(`${base}/api/probe`, { method: "POST", headers: { cookie, origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("says offline when no agent is connected, and refuses a wrong agent token", async () => {
    const { base, relay, agent, login } = await setupRelay({ token: "wrong-token" });
    const { cookie } = await login();
    await until(() => agent!.status().lastError !== null);
    expect(relay.agentConnected()).toBe(false);
    expect(agent!.status()).toMatchObject({ state: "connecting", lastError: expect.stringContaining("HTTP 401") });
    const r = await fetch(`${base}/api/projects`, { headers: { cookie } });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "agent_offline" });
  });

  it("refuses to reach anything but the local engine", async () => {
    const { base, relay, engine, login } = await setupRelay();
    await until(relay.agentConnected);
    const { cookie } = await login();
    const before = engine.seen.length;
    const r = await fetch(`${base}//evil.example/x`, { headers: { cookie } });
    // `//evil.example/x` resolves to another origin, so the agent refuses it.
    expect(r.status).toBe(502);
    expect(engine.seen.length).toBe(before);
  });
});

describe("remote policy (SPEC §18.3)", () => {
  it("allows what the dashboard uses, asks for merge, new and deleted projects, refuses the rest", () => {
    const d = (m: string, p: string) => remoteDecision(m, p).kind;
    expect(d("GET", "/")).toBe("allow");
    expect(d("GET", "/projects/demo")).toBe("allow"); // client-side route
    expect(d("GET", "/assets/index-abc.js")).toBe("allow");
    expect(d("GET", "/api/projects/demo/sketch/files/2/main-1280.png")).toBe("allow");
    expect(d("GET", "/api/events/stream")).toBe("allow");
    expect(d("POST", "/api/projects/demo/sketch/approve")).toBe("allow");
    expect(d("PATCH", "/api/tasks/t1")).toBe("allow");
    expect(d("POST", "/api/remote/disable")).toBe("allow");
    expect(remoteDecision("POST", "/api/projects")).toEqual({ kind: "confirm", action: "new_project" });
    expect(remoteDecision("POST", "/api/projects/demo/merge-base")).toEqual({ kind: "confirm", action: "merge" });
    expect(d("POST", "/api/remote/enable")).toBe("deny");
    expect(d("GET", "/api/some-new-route")).toBe("deny");
    expect(d("DELETE", "/api/projects/demo")).toBe("confirm");
    expect(d("DELETE", "/api/runs/r1")).toBe("deny");
    expect(d("PUT", "/api/projects/demo")).toBe("deny");
    expect(d("POST", "/api/projects/demo/start/extra")).toBe("deny");
  });

  it("describes the confirmation in plain words", () => {
    expect(describeConfirm("merge", "/api/projects/01PROJ/merge-base")).toBe("Merge project “01PROJ” into its main branch.");
    expect(describeConfirm("merge", "/api/projects/01PROJ/merge-base", undefined, { name: "Shop", slug: "shop" })).toBe("Merge project “Shop” (shop) into its main branch.");
    expect(describeConfirm("delete_project", "/api/projects/01PROJ", undefined, { name: "links", slug: "links" })).toBe("Delete project “links” from Orys.");
    const body = Buffer.from(JSON.stringify({ name: "Shop", repoPath: "/Users/me/shop", workspace: "sandbox" }));
    expect(describeConfirm("new_project", "/api/projects", body)).toBe("Create project “Shop” in /Users/me/shop (on a copy).");
    expect(describeConfirm("new_project", "/api/projects", Buffer.from("not json"))).toBe("Create project “unnamed” in a new folder.");
  });

  it("the agent refuses unlisted routes and waits for a click on the computer before merging", async () => {
    const asked: string[] = [];
    let answer = false;
    const confirm: Confirm = async ({ detail }) => {
      asked.push(detail);
      return answer;
    };
    const { base, relay, engine, login } = await setupRelay({ agent: { confirm } });
    await until(relay.agentConnected);
    const { cookie } = await login();
    const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
    const before = engine.seen.length;

    const denied = await post("/api/remote/enable");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: REFUSED_REMOTE });

    const notConfirmed = await post("/api/projects/01PROJ/merge-base");
    expect(notConfirmed.status).toBe(403);
    expect(await notConfirmed.json()).toEqual({ error: NOT_CONFIRMED });
    // The dialog names the project the way the owner knows it, not by its id.
    expect(asked).toEqual(["Merge project “Mali servis” (mali-servis) into its main branch."]);
    // Only the name lookup reached the engine; neither change did.
    expect(engine.seen.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/projects/01PROJ"]);

    answer = true;
    const merged = await post("/api/projects/01PROJ/merge-base");
    expect(merged.status).toBe(200);
    expect(engine.seen.at(-1)).toMatchObject({ method: "POST", url: "/api/projects/01PROJ/merge-base" });
    // A project the engine does not know is shown by its id.
    answer = false;
    await post("/api/projects/unknown-id/merge-base");
    expect(asked.at(-1)).toBe("Merge project “unknown-id” into its main branch.");
  });

  it("without a way to ask, merge and new projects are refused", async () => {
    const { base, relay, login } = await setupRelay();
    await until(relay.agentConnected);
    const { cookie } = await login();
    const r = await fetch(`${base}/api/projects`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});

describe("relay hardening (SPEC §18.3)", () => {
  it("sets security headers on its own pages and on forwarded ones, keeping a mockup's stricter CSP", async () => {
    const { base, relay, login } = await setupRelay();
    await until(relay.agentConnected);
    const { cookie } = await login();
    const page = await fetch(`${base}/api/projects`, { headers: { cookie } });
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("strict-transport-security")).toBeNull(); // plain http in tests
    const mockup = await fetch(`${base}/api/projects/demo/designs/calm.html`, { headers: { cookie } });
    expect(mockup.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const loginPage = await fetch(`${base}/_relay/login`);
    expect(loginPage.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("sends HSTS behind HTTPS", async () => {
    const { base } = await setupRelay({ withAgent: false, relay: { secureCookie: true } });
    expect((await fetch(`${base}/_relay/health`)).headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("pauses every login after 30 failures from many addresses", async () => {
    const { login } = await setupRelay({ withAgent: false });
    for (let ip = 1; ip <= 3; ip++) {
      for (let i = 0; i < 10; i++) expect((await login("nope", { "cf-connecting-ip": `203.0.113.${ip}` })).status).toBe(303);
    }
    // A fresh address with the right password: still paused.
    expect((await login(PASSWORD, { "cf-connecting-ip": "198.51.100.7" })).status).toBe(429);
  });
});

describe("Cloudflare Access in the relay (SPEC §18.3)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as AccessJwk), kid: "k1" };
  const jwt = (claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "k1") => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc({ iss: "https://team.cloudflareaccess.com", aud: ["AUD"], exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    return `${head}.${sign("sha256", Buffer.from(head), key).toString("base64url")}`;
  };
  const access: AccessOptions = { team: "team", aud: "AUD", emails: ["owner@example.com"], agentClientId: "agent-cid", fetchKeys: async () => [jwk] };
  const owner = jwt({ email: "Owner@Example.com" });
  const service = jwt({ common_name: "agent-cid" });

  it("every request needs a valid Access token for an allowed email; health stays open", async () => {
    const { base } = await setupRelay({ withAgent: false, relay: { access } });
    const get = (token?: string) => fetch(`${base}/`, { headers: { accept: "text/html", ...(token ? { "cf-access-jwt-assertion": token } : {}) }, redirect: "manual" });
    expect((await fetch(`${base}/_relay/health`)).status).toBe(200);
    expect((await get()).status).toBe(403);
    expect((await get(jwt({ email: "owner@example.com", aud: ["OTHER"] }))).status).toBe(403);
    expect((await get(jwt({ email: "owner@example.com", exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(403);
    expect((await get(jwt({ email: "stranger@example.com" }))).status).toBe(403);
    expect((await get(jwt({ email: "owner@example.com" }, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey))).status).toBe(403);
    expect((await get(service)).status).toBe(403); // a service token cannot open the dashboard
    const ok = await get(owner);
    expect(ok.status).toBe(303); // through Access, on to the password
    expect(ok.headers.get("location")).toBe("/_relay/login");
  });

  it("only the agent's service token may connect the agent", async () => {
    const attempt = async (token: string) => {
      const { relay, agent } = await setupRelay({ relay: { access }, agent: { headers: { "cf-access-jwt-assertion": token } } });
      await until(() => relay.agentConnected() || agent!.status().lastError !== null);
      return relay.agentConnected();
    };
    expect(await attempt(owner)).toBe(false);
    expect(await attempt(jwt({ common_name: "someone-else" }))).toBe(false);
    expect(await attempt(service)).toBe(true);
  });
});

describe("remote access in the engine (SPEC §18.3)", () => {
  async function engineWithRemote(config: object | null) {
    const dir = mkdtempSync(join(tmpdir(), "orys-remote-"));
    const configPath = join(dir, "agent.json");
    if (config) writeFileSync(configPath, JSON.stringify(config));
    const started: AgentOptions[] = [];
    let stops = 0;
    const remote = new RemoteAccess({
      statePath: join(dir, "remote.json"),
      configPath,
      env: {},
      target: "http://127.0.0.1:1",
      start: (opts) => {
        started.push(opts);
        return { stop: () => void stops++, connected: () => true, status: () => ({ state: "connected", since: 1, lastError: null }) };
      },
    });
    const { db, deps, config: cfg } = await setup([], { planned: false });
    const server = buildServer({ app: { ...deps, db, config: cfg }, webDir: null, remote });
    const call = async (method: "GET" | "POST" | "DELETE", url: string, remoteHeader = false) => {
      const r = await server.inject({ method, url, headers: remoteHeader ? { "x-orys-remote": "1" } : {}, payload: method === "GET" ? undefined : {} });
      return { status: r.statusCode, body: r.json() };
    };
    return { remote, started, stops: () => stops, call, dir };
  }

  it("not set up: says so and does not connect", async () => {
    const { remote, started, call } = await engineWithRemote(null);
    remote.boot();
    expect(started).toHaveLength(0);
    expect((await call("GET", "/api/remote")).body).toMatchObject({ available: true, configured: false, state: "not_configured", via: "local" });
  });

  it("the dashboard turns it off and on; the switch survives a restart; the phone can only turn it off", async () => {
    const cfg = { relay: "wss://orys.example.com/_relay/agent", token: "t", accessClientId: "cid", accessClientSecret: "secret" };
    const { remote, started, stops, call } = await engineWithRemote(cfg);
    remote.boot();
    expect(started).toHaveLength(1);
    expect(started[0]!.headers).toEqual({ "cf-access-client-id": "cid", "cf-access-client-secret": "secret" });
    expect((await call("GET", "/api/remote")).body).toMatchObject({ state: "connected", relayHost: "orys.example.com", serviceToken: true, enabled: true });

    expect((await call("POST", "/api/remote/enable", true)).status).toBe(403); // from the phone
    expect((await call("POST", "/api/remote/disable")).body).toMatchObject({ enabled: false, state: "off" });
    expect(stops()).toBe(1);

    remote.boot(); // a restart: stays off
    expect(started).toHaveLength(1);
    expect((await call("POST", "/api/remote/enable")).body).toMatchObject({ enabled: true, state: "connected" });
    expect(started).toHaveLength(2);
  });

  it("the engine checks the remote policy again for requests the agent marked", async () => {
    const { call } = await engineWithRemote(null);
    expect((await call("GET", "/api/projects", true)).status).toBe(200);
    expect((await call("GET", "/api/remote", true)).body).toMatchObject({ via: "remote" });
    expect((await call("DELETE", "/api/runs/r1", true)).status).toBe(403);
    expect((await call("GET", "/api/some-new-route", true)).status).toBe(403);
  });
});

/**
 * Orys hub (SPEC §18.5): Orys for invited people. GitHub login (invite-only), device
 * pairing by code, and a pass-through from each person's browser to the computer they
 * paired, and only theirs. Never runs `claude`, stores no project data.
 *
 * Standalone like the relay: node builtins, `ws` and ./store.ts, run with type stripping.
 * The agent protocol is the relay's (src/relay/protocol.ts), so `orys serve --agent`
 * talks to either.
 */
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentToRelay, RelayToAgent } from "../relay/protocol.js";
import { HubStore, newSecret, PAIRING_MINUTES, type Device, type User } from "./store.ts";

// Kept in sync with src/relay/protocol.ts and server.ts (runtime values can't be imported, see header).
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "last-event-id", "user-agent"];
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"]);
const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const MAX_BODY = 5 * 1024 * 1024;
const MAX_FORM = 16 * 1024;
const MAX_AGENTS = 500;
const MAX_INFLIGHT_PER_DEVICE = 64;
/** A browser that does not read fast enough: past this much buffered, the request is dropped. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const PING_MS = 20_000;
const RECHECK_MS = 30_000;

export type GithubUser = { id: number; login: string };
export type GithubClient = {
  authorizeUrl: (state: string, redirectUri: string) => string;
  /** Exchange the callback code for the GitHub account; the access token is dropped right away. */
  userFromCode: (code: string, redirectUri: string) => Promise<GithubUser>;
};

export function githubOAuth(clientId: string, clientSecret: string): GithubClient {
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "false" })}`,
    async userFromCode(code, redirectUri) {
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      const t = (await r.json()) as { access_token?: string; error?: string };
      if (!t.access_token) throw new Error(`GitHub: ${t.error ?? `HTTP ${r.status}`}`);
      try {
        const u = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "orys-hub" },
          signal: AbortSignal.timeout(10_000),
        });
        const j = (await u.json()) as { id?: unknown; login?: unknown };
        if (!u.ok || typeof j.id !== "number" || typeof j.login !== "string") throw new Error(`GitHub user lookup: HTTP ${u.status}`);
        return { id: j.id, login: j.login };
      } finally {
        // Leave no live GitHub token behind: Orys needs the identity once, nothing else.
        void fetch(`https://api.github.com/applications/${clientId}/token`, {
          method: "DELETE",
          headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, accept: "application/vnd.github+json", "user-agent": "orys-hub" },
          body: JSON.stringify({ access_token: t.access_token }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      }
    },
  };
}

export type HubOptions = {
  store: HubStore;
  /** e.g. https://orys.example.com (no trailing slash): OAuth redirect, pairing links, Origin checks. */
  publicUrl: string;
  github: GithubClient;
  /** Secure cookies (`__Host-`) and HSTS; off only in local tests over http. */
  secure?: boolean;
  /** The Orys package (a .tgz) handed to invited people; without it, no install command. */
  distPath?: string;
  log?: (line: string) => void;
};

type Pending = { res: ServerResponse; headersSent: boolean; userId: number };
type AgentConn = { ws: WebSocket; deviceId: number; userId: number; alive: boolean; pending: Map<number, Pending> };

/** Fixed-window counters for rate limits. */
class Limiter {
  private hits = new Map<string, { n: number; until: number }>();
  /** true when allowed */
  take(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      this.hits.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= max;
  }
  prune() {
    const now = Date.now();
    for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k);
  }
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createHub(opts: HubOptions): { server: Server; online: (deviceId: number) => boolean; recheck: () => void; close: () => Promise<void> } {
  const { store, github } = opts;
  const log = opts.log ?? ((l: string) => console.log(`${new Date().toISOString()} ${l}`));
  const secure = opts.secure ?? true;
  const base = new URL(opts.publicUrl);
  const origin = base.origin;
  const redirectUri = `${origin}/_hub/auth/github`;
  const COOKIE = secure ? "__Host-orys_hub" : "orys_hub";
  const STATE_COOKIE = secure ? "__Host-orys_oauth" : "orys_oauth";
  const INVITE_COOKIE = secure ? "__Host-orys_invite" : "orys_invite";
  const limiter = new Limiter();
  const agents = new Map<number, AgentConn>();
  let nextId = 1;

  const cookie = (req: IncomingMessage, name: string) => {
    for (const part of (req.headers.cookie ?? "").split(/;\s*/)) if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
    return undefined;
  };
  const setCookie = (name: string, value: string, maxAgeSec: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  const clientIp = (req: IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === origin;

  // ---- pages ------------------------------------------------------------------------
  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const sendPage = (res: ServerResponse, status: number, title: string, body: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP, ...headers });
    res.end(page(title, body));
  };
  const redirect = (res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(303, { location: to, "cache-control": "no-store", ...headers });
    res.end();
  };
  const wantsHtml = (req: IncomingMessage) => req.method === "GET" && (req.headers.accept ?? "").includes("text/html");

  // ---- agents -------------------------------------------------------------------------
  const failPending = (conn: AgentConn, reason: string) => {
    for (const [id, p] of conn.pending) {
      if (p.headersSent) p.res.destroy();
      else sendJson(p.res, 502, { error: "agent_offline", message: reason });
      conn.pending.delete(id);
    }
  };
  const dropAgent = (deviceId: number, code: number, reason: string) => {
    const conn = agents.get(deviceId);
    if (!conn) return;
    agents.delete(deviceId);
    failPending(conn, reason);
    conn.ws.close(code, reason);
  };

  /** Frames only ever touch this connection's own requests: one computer can never answer for another. */
  const onAgentFrame = (conn: AgentConn, frame: AgentToRelay) => {
    if (frame.t === "hello") return;
    const p = conn.pending.get(frame.id);
    if (!p) return;
    switch (frame.t) {
      case "head": {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(frame.headers ?? {})) if (typeof v === "string" && !DROPPED_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
        const status = Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 ? frame.status : 502;
        p.res.writeHead(status, headers);
        p.res.flushHeaders();
        p.headersSent = true;
        break;
      }
      case "chunk":
        if (!p.headersSent || typeof frame.data !== "string") return;
        p.res.write(Buffer.from(frame.data, "base64"));
        if (p.res.writableLength > MAX_BUFFERED) {
          conn.pending.delete(frame.id);
          send(conn, { t: "cancel", id: frame.id });
          p.res.destroy();
        }
        break;
      case "end":
        p.res.end();
        conn.pending.delete(frame.id);
        break;
      case "error":
        if (p.headersSent) p.res.destroy();
        else sendJson(p.res, 502, { error: "agent_error", message: String(frame.message).slice(0, 300) });
        conn.pending.delete(frame.id);
        break;
    }
  };
  const send = (conn: AgentConn, frame: RelayToAgent) => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame));
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage, device: Device) => {
    dropAgent(device.id, 4000, "replaced by a new connection");
    const conn: AgentConn = { ws, deviceId: device.id, userId: device.userId, alive: true, pending: new Map() };
    agents.set(device.id, conn);
    store.touchDevice(device.id, clientIp(req));
    log(`device ${device.id} (user ${device.userId}) connected from ${clientIp(req)}`);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data) => {
      try {
        onAgentFrame(conn, JSON.parse(String(data)) as AgentToRelay);
      } catch {
        // malformed frame: ignored
      }
    });
    ws.on("close", () => {
      if (agents.get(device.id) !== conn) return;
      agents.delete(device.id);
      failPending(conn, "the computer went offline");
      log(`device ${device.id} disconnected`);
    });
  });

  /** Revocations and disabled accounts made with the operator CLI (another process) take effect here. */
  const recheck = () => {
    for (const conn of [...agents.values()]) {
      const d = store.device(conn.deviceId);
      const u = d && store.userById(d.userId);
      if (!d || d.revoked || !u || u.disabled) dropAgent(conn.deviceId, 4001, "revoked");
      else store.touchDevice(d.id, null);
    }
    limiter.prune();
  };
  const timers = [
    setInterval(() => {
      for (const conn of agents.values()) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }, PING_MS),
    setInterval(recheck, RECHECK_MS),
  ];
  for (const t of timers) t.unref();

  // ---- HTTP -------------------------------------------------------------------------------
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
    try {
      await handle(req, res);
    } catch (e) {
      log(`error on ${req.method} ${(req.url ?? "").slice(0, 200)}: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, (e as Error).message === "body too large" ? 413 : 500, { error: "hub_error" });
      else res.destroy();
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    const ip = clientIp(req);
    if (path === "/_hub/health") return sendJson(res, 200, { ok: true });
    if (path.startsWith("/_hub/")) return hubRoute(req, res, url, ip);
    return forward(req, res, url);
  }

  const auth = (req: IncomingMessage) => store.session(cookie(req, COOKIE));

  async function hubRoute(req: IncomingMessage, res: ServerResponse, url: URL, ip: string) {
    const path = url.pathname;
    const m = req.method ?? "GET";
    if (m !== "GET" && m !== "HEAD" && path.startsWith("/_hub/api/") === false && !sameOrigin(req)) return sendJson(res, 403, { error: "bad_origin" });

    // -- sign in -------------------------------------------------------------------
    if (path === "/_hub/login" && m === "GET") {
      if (!limiter.take(`login:${ip}`, 30, 10 * 60_000)) return sendPage(res, 429, "Slow down", `<h1>Too many attempts</h1><p>Try again in a few minutes.</p>`);
      const state = newSecret();
      return redirect(res, github.authorizeUrl(state, redirectUri), { "set-cookie": setCookie(STATE_COOKIE, state, 600) });
    }
    if (path === "/_hub/auth/github" && m === "GET") {
      const state = cookie(req, STATE_COOKIE);
      const code = url.searchParams.get("code");
      const clear = [setCookie(STATE_COOKIE, "", 0), setCookie(INVITE_COOKIE, "", 0)];
      if (!state || !code || !safeEqual(state, url.searchParams.get("state") ?? "")) {
        return sendPage(res, 400, "Sign-in failed", `<h1>Sign-in failed</h1><p>The sign-in link expired or was not started here.</p><a class="btn" href="/_hub/login">Try again</a>`, { "set-cookie": clear });
      }
      let gh: GithubUser;
      try {
        gh = await github.userFromCode(code, redirectUri);
      } catch (e) {
        log(`GitHub sign-in failed from ${ip}: ${(e as Error).message}`);
        return sendPage(res, 502, "Sign-in failed", `<h1>Sign-in failed</h1><p>GitHub did not confirm the sign-in.</p><a class="btn" href="/_hub/login">Try again</a>`, { "set-cookie": clear });
      }
      let user = store.userByGithub(gh.id);
      if (user?.disabled) {
        store.audit(user.id, "login_refused_disabled", { ip });
        return sendPage(res, 403, "Account disabled", `<h1>Account disabled</h1><p>Ask the person who invited you.</p>`, { "set-cookie": clear });
      }
      if (user) {
        if (user.login !== gh.login) store.updateLogin(user.id, gh.login);
      } else {
        const invite = cookie(req, INVITE_COOKIE);
        user = invite ? store.redeemInvite(invite, gh.id, gh.login) : undefined;
        if (!user) {
          store.audit(null, "login_refused_no_invite", { github: gh.login, ip });
          return sendPage(res, 403, "Invite only", `<h1>Orys is invite-only</h1><p>There is no account for <b>${esc(gh.login)}</b>. Ask for an invite link and open it first.</p>`, { "set-cookie": clear });
        }
      }
      const token = store.createSession(user.id, ip, String(req.headers["user-agent"] ?? ""));
      return redirect(res, "/_hub/", { "set-cookie": [...clear, setCookie(COOKIE, token, 7 * 86_400)] });
    }
    const invite = /^\/_hub\/invite\/([A-Za-z0-9_-]{20,100})$/.exec(path);
    if (invite && m === "GET") {
      if (!limiter.take(`invite:${ip}`, 30, 10 * 60_000)) return sendPage(res, 429, "Slow down", `<h1>Too many attempts</h1>`);
      if (!store.inviteValid(invite[1]!)) return sendPage(res, 410, "Invite not valid", `<h1>This invite is not valid</h1><p>It was used already or it expired. Ask for a new one.</p>`);
      return sendPage(
        res,
        200,
        "You are invited",
        `<h1>You are invited to Orys</h1><p>Orys runs AI agents on <b>your own computer</b>, with your own Claude subscription. Sign in with GitHub to open your account.</p><a class="btn" href="/_hub/login">Sign in with GitHub</a>`,
        { "set-cookie": setCookie(INVITE_COOKIE, invite[1]!, 1800) },
      );
    }

    // -- the agent side of pairing (no browser, no cookies) -------------------------------
    if (path === "/_hub/api/pair/start" && m === "POST") {
      if (!limiter.take(`pair:${ip}`, 10, 60 * 60_000)) return sendJson(res, 429, { error: "too_many_requests" });
      const body = await readJson(req);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "computer";
      const p = store.startPairing(name.replace(/[^\w .@()-]/g, "").slice(0, 60) || "computer", ip);
      return sendJson(res, 200, {
        device_code: p.deviceCode,
        user_code: p.userCode,
        verification_uri: `${origin}/_hub/pair`,
        verification_uri_complete: `${origin}/_hub/pair?code=${p.userCode}`,
        expires_in: PAIRING_MINUTES * 60,
        interval: 5,
      });
    }
    if (path === "/_hub/api/pair/poll" && m === "POST") {
      if (!limiter.take(`poll:${ip}`, 300, 10 * 60_000)) return sendJson(res, 429, { error: "too_many_requests" });
      const body = await readJson(req);
      const r = store.pollPairing(typeof body.device_code === "string" ? body.device_code : "", 3_000);
      if (r.status === "approved") return sendJson(res, 200, { status: "approved", token: r.token, agent_url: `${origin.replace(/^http/, "ws")}/_hub/agent` });
      return sendJson(res, r.status === "expired" ? 410 : 200, { status: r.status });
    }

    // -- the install command (curl, with a one-time token instead of a session) -------------
    if ((path === "/_hub/install.sh" || path === "/_hub/dist/orys.tgz") && m === "GET") {
      if (!limiter.take(`install:${ip}`, 30, 60 * 60_000)) return sendJson(res, 429, { error: "too_many_requests" });
      const t = url.searchParams.get("t") ?? "";
      const spend = path === "/_hub/dist/orys.tgz";
      const userId = opts.distPath && existsSync(opts.distPath) ? store.installToken(t, spend) : undefined;
      if (userId == null) return sendJson(res, 410, { error: "This install link is used, expired or wrong. Get a new one at /_hub/install." });
      if (!spend) {
        res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" });
        return res.end(installScript(origin, t));
      }
      res.writeHead(200, { "content-type": "application/gzip", "content-length": String(statSync(opts.distPath!).size), "cache-control": "no-store" });
      createReadStream(opts.distPath!).pipe(res);
      return;
    }

    // -- signed-in pages ----------------------------------------------------------------
    const a = auth(req);
    if (path === "/_hub/" && m === "GET" && !a) {
      return sendPage(res, 200, "Orys", `<h1>Orys</h1><p>AI project agents that run on your own computer. Invite only.</p><a class="btn" href="/_hub/login">Sign in with GitHub</a>`);
    }
    if (!a) return wantsHtml(req) ? redirect(res, "/_hub/") : sendJson(res, 401, { error: "login_required" });
    const { user, session } = a;
    if (!limiter.take(`user:${user.id}`, 600, 60_000)) return sendJson(res, 429, { error: "too_many_requests" });

    if ((path === "/_hub/" || path === "/_hub/devices") && m === "GET") return sendPage(res, 200, "Your computers", devicesPage(user, session.deviceId));
    if (path === "/_hub/devices/select" && m === "POST") {
      const id = Number((await readForm(req)).get("id"));
      if (!store.selectDevice(session.id, user.id, id)) return sendPage(res, 404, "Not found", `<h1>Computer not found</h1><a class="btn" href="/_hub/devices">Back</a>`);
      return redirect(res, "/");
    }
    if (path === "/_hub/devices/revoke" && m === "POST") {
      const id = Number((await readForm(req)).get("id"));
      if (store.revokeDevice(id, user.id)) dropAgent(id, 4001, "revoked");
      return redirect(res, "/_hub/devices");
    }
    if (path === "/_hub/sessions/revoke-others" && m === "POST") {
      store.deleteOtherSessions(user.id, session.id);
      return redirect(res, "/_hub/devices");
    }
    if (path === "/_hub/logout" && m === "POST") {
      store.deleteSession(cookie(req, COOKIE)!);
      return redirect(res, "/_hub/", { "set-cookie": setCookie(COOKIE, "", 0) });
    }
    if (path === "/_hub/pair" && m === "GET") return sendPage(res, 200, "Connect a computer", pairPage(url.searchParams.get("code") ?? ""));
    if (path === "/_hub/install" && m === "GET") {
      if (!opts.distPath || !existsSync(opts.distPath)) return sendPage(res, 503, "Install Orys", `<h1>Install Orys</h1><p>The package is not available right now.</p>`);
      const t = store.createInstallToken(user.id);
      const cmd = `curl -fsSL '${origin}/_hub/install.sh?t=${t}' | bash`;
      return sendPage(
        res,
        200,
        "Install Orys",
        `<h1>Install Orys on your computer</h1>
<p>You need <b>Node 22+</b>, <b>git</b> and <b>Claude Code</b> signed in with your own Claude subscription. Orys runs there, with your account; nothing of yours runs here.</p>
<p>In a terminal on that computer (macOS or Linux), run this once. The link works one time, for an hour:</p>
<p><code>${esc(cmd)}</code></p>
<p class="muted">It installs into <code>~/.orys/app</code>, then shows a code to connect the computer to your account.</p>
<a class="btn" href="/_hub/devices">Your computers</a>`,
      );
    }
    if (path === "/_hub/pair" && m === "POST") {
      const form = await readForm(req);
      const code = form.get("code") ?? "";
      if (form.get("approve") !== "yes") {
        const found = store.findPairing(user.id, code);
        if (!found.ok) return sendPage(res, found.reason === "locked" ? 429 : 400, "Connect a computer", pairPage(code, found.reason));
        const p = found.pairing;
        // Device-code phishing: someone else's code, typed in by you, would hand them your account.
        const elsewhere = p.ip && p.ip !== ip;
        return sendPage(
          res,
          200,
          "Connect a computer",
          `<h1>Connect this computer?</h1><p><b>${esc(p.name)}</b>, asking from ${esc(p.ip ?? "?")}.</p>${
            elsewhere
              ? `<p class="err"><b>Careful:</b> this code was started from a different network (${esc(p.ip)}) than the one you are on now (${esc(ip)}). If someone sent you this code, do not continue: they would get your account.</p>`
              : ""
          }<p>It gets access to your Orys account. Approve only if you just ran <code>orys agent login</code> there yourself.</p>
<form method="post" action="/_hub/pair"><input type="hidden" name="code" value="${esc(p.userCode)}"><input type="hidden" name="approve" value="yes"><button type="submit">Connect</button></form><p><a href="/_hub/devices">Cancel</a></p>`,
        );
      }
      const r = store.approvePairing(user.id, code);
      if (!r.ok) return sendPage(res, r.reason === "locked" ? 429 : 400, "Connect a computer", pairPage(code, r.reason));
      return sendPage(res, 200, "Connected", `<h1>Connected</h1><p><b>${esc(r.pairing.name)}</b> is now yours. Go back to its terminal; it finishes on its own.</p><a class="btn" href="/_hub/devices">Your computers</a>`);
    }
    return sendJson(res, 404, { error: "not_found" });
  }

  // ---- the pass-through: a signed-in person reaches only a computer of their own ---------------------
  async function forward(req: IncomingMessage, res: ServerResponse, url: URL) {
    const a = auth(req);
    if (!a) return wantsHtml(req) ? redirect(res, "/_hub/") : sendJson(res, 401, { error: "login_required" });
    const { user, session } = a;
    const method = req.method ?? "GET";
    const changesState = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (changesState && !sameOrigin(req)) return sendJson(res, 403, { error: "bad_origin" });
    if (!limiter.take(`user:${user.id}`, 600, 60_000)) return sendJson(res, 429, { error: "too_many_requests" });

    let deviceId = session.deviceId;
    if (deviceId == null) {
      const mine = store.devicesOf(user.id);
      if (mine.length === 1 && store.selectDevice(session.id, user.id, mine[0]!.id)) deviceId = mine[0]!.id;
    }
    // Checked on every request, against the database: the device must be this account's and not revoked.
    const device = deviceId == null ? undefined : store.device(deviceId);
    if (!device || device.userId !== user.id || device.revoked) {
      return wantsHtml(req) ? redirect(res, "/_hub/devices") : sendJson(res, 409, { error: "no_computer", message: "Pick one of your computers at /_hub/devices" });
    }
    const conn = agents.get(device.id);
    if (!conn || conn.userId !== user.id) {
      return wantsHtml(req)
        ? sendPage(res, 503, "Offline", `<h1>${esc(device.name)} is offline</h1><p>Orys on that computer is not connected right now: it is asleep, off, or remote access is turned off there.</p><a class="btn" href="/_hub/devices">Your computers</a>`, { refresh: "15" })
        : sendJson(res, 503, { error: "agent_offline" });
    }
    if (conn.pending.size >= MAX_INFLIGHT_PER_DEVICE) return sendJson(res, 429, { error: "too_many_requests" });

    const headers: Record<string, string> = {};
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const body = changesState ? await readBody(req, MAX_BODY) : undefined;
    const id = nextId++;
    conn.pending.set(id, { res, headersSent: false, userId: user.id });
    res.on("close", () => {
      if (conn.pending.delete(id)) send(conn, { t: "cancel", id });
    });
    send(conn, { t: "req", id, method, url: url.pathname + url.search, headers, body: body?.length ? body.toString("base64") : undefined });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", origin);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const device = url.pathname === "/_hub/agent" && token ? store.deviceByToken(token) : undefined;
    if (!device || (agents.size >= MAX_AGENTS && !agents.has(device.id))) {
      if (!limiter.take(`badagent:${clientIp(req)}`, 30, 10 * 60_000)) {
        socket.destroy();
        return;
      }
      log(`refused an agent connection from ${clientIp(req)}`);
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.on("error", () => socket.destroy());
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, device));
  });

  // ---- page bodies --------------------------------------------------------------------------
  function devicesPage(user: User, selected: number | null): string {
    const devices = store.devicesOf(user.id);
    const rows = devices
      .map((d) => {
        const on = agents.has(d.id);
        const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never";
        return `<li class="dev"><div><b>${esc(d.name)}</b> <span class="${on ? "on" : "off"}">${on ? "online" : "offline"}</span>${d.id === selected ? " <span class=\"cur\">current</span>" : ""}
<div class="muted">last seen ${esc(seen)}${d.lastIp ? ` from ${esc(d.lastIp)}` : ""}</div></div>
<div class="acts"><form method="post" action="/_hub/devices/select"><input type="hidden" name="id" value="${d.id}"><button type="submit">Open</button></form>
<form method="post" action="/_hub/devices/revoke"><input type="hidden" name="id" value="${d.id}"><button type="submit" class="ghost">Remove</button></form></div></li>`;
      })
      .join("");
    return `<h1>Your computers</h1><p class="muted">Signed in as <b>${esc(user.login)}</b>.</p>
${devices.length ? `<ul class="devs">${rows}</ul>` : `<p>No computer yet. <a href="/_hub/install">Install Orys</a> on your computer; at the end it shows a code to enter on the <a href="/_hub/pair">connect page</a>.</p>`}
<p><a class="btn" href="/_hub/pair">Connect a computer</a> <a class="btn" href="/_hub/install">Install Orys</a></p>
<form method="post" action="/_hub/sessions/revoke-others"><button type="submit" class="ghost">Sign out everywhere else</button></form>
<form method="post" action="/_hub/logout"><button type="submit" class="ghost">Sign out</button></form>`;
  }

  function pairPage(code: string, error?: "locked" | "invalid" | "too_many_devices"): string {
    const msg =
      error === "locked"
        ? "Too many wrong codes. Wait 15 minutes."
        : error === "too_many_devices"
          ? "You already have 3 computers. Remove one first."
          : error === "invalid"
            ? "That code is not valid or expired. Run <code>orys agent login</code> again for a new one."
            : "";
    return `<h1>Connect a computer</h1><p>Enter the code your computer shows after <code>orys agent login</code>.</p>
<form method="post" action="/_hub/pair"><input name="code" value="${esc(code)}" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
${msg ? `<div class="err">${msg}</div>` : ""}<button type="submit">Continue</button></form><p><a href="/_hub/devices">Your computers</a></p>`;
  }

  return {
    server,
    online: (deviceId) => agents.has(deviceId),
    recheck,
    close: async () => {
      for (const t of timers) clearInterval(t);
      for (const id of [...agents.keys()]) dropAgent(id, 1001, "hub shutting down");
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
const readForm = async (req: IncomingMessage) => new URLSearchParams((await readBody(req, MAX_FORM)).toString("utf8"));
const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  try {
    const v = JSON.parse((await readBody(req, MAX_FORM)).toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** What the install command runs on the person's computer. Everything it fetches comes from this hub. */
function installScript(origin: string, token: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/usr/bin/env bash
# Orys installer from ${origin} (SPEC §18.5). Installs into ~/.orys/app and pairs this computer.
set -euo pipefail
HUB=${q(origin)}
TOKEN=${q(token)}
DEST="$HOME/.orys/app"
need() { command -v "$1" >/dev/null 2>&1 || { echo "Orys needs $1: $2" >&2; exit 1; }; }
need node "install Node 22 or newer (e.g. brew install node)"
need git "install git"
need curl "install curl"
need claude "install Claude Code and sign in with your own Claude account first (https://claude.com/claude-code)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Orys needs Node 22 or newer (you have $(node --version))" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "Downloading Orys…"
curl -fsSL "$HUB/_hub/dist/orys.tgz?t=$TOKEN" -o "$tmp/orys.tgz"
mkdir -p "$DEST"
tar -xzf "$tmp/orys.tgz" -C "$DEST"   # keeps your data/ on an update
cd "$DEST"
echo "Installing dependencies…"
npx --yes pnpm@12.18.0 install --frozen-lockfile --silent
echo
node --import tsx src/cli/index.ts agent login --hub "$HUB"
if [ "$(uname)" = Darwin ] && [ "\${ORYS_NO_SERVICE:-}" != 1 ]; then
  bash scripts/launchd.sh install
else
  echo "Start Orys with:  cd $DEST && node --import tsx src/cli/index.ts serve --agent"
fi
echo "Done. Open $HUB from any device."
`;
}

const PAGE_STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--fg:#1b1b1a;--muted:#6b6a66;--line:#e3e1dc;--accent:#1b1b1a;--accent-fg:#fff;--bad:#b4371f;--ok:#2f7d32}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b1a;--fg:#ecebe7;--muted:#9a9893;--line:#2c2b29;--accent:#ecebe7;--accent-fg:#121211;--bad:#ef7a5f;--ok:#8bc78e}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:16px}
.card{width:100%;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 16px}.muted{color:var(--muted);font-size:13px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;margin-bottom:12px;letter-spacing:.08em}
button,a.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:0;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
form{margin:0 0 10px}code{font-size:13px;overflow-wrap:anywhere}.err{color:var(--bad);margin:-4px 0 12px;font-size:14px}
.devs{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:10px}.dev{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:12px}
.acts{display:flex;gap:8px}.acts form{margin:0}.on{color:var(--ok);font-size:13px}.off,.cur{color:var(--muted);font-size:13px}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orys · ${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main class="card">${body}</main></body></html>`;
}

// ---- entry point: `node src/hub/server.ts [command]` on the server -------------------------------
async function main() {
  const env = process.env;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const store = new HubStore(need("ORYS_HUB_DB"));
  // `--json` anywhere: one JSON value on stdout, for the owner's dashboard (src/server/hubAdmin.ts).
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const [cmd = "serve", arg] = argv.filter((a) => a !== "--json");
  const hubUrl = (env.ORYS_HUB_URL ?? "").replace(/\/$/, "");
  const out = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value) : text());
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : "never");
  const id = () => {
    const n = Number(arg);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not an id: ${arg ?? "(missing)"}`);
    return n;
  };
  const findUser = () => {
    const u = arg ? store.userByLogin(arg) : undefined;
    if (!u) throw new Error(`no user ${arg ?? "(missing login)"}`);
    return u;
  };
  const audit = (n: number) =>
    store.auditLog(n).map((e) => {
      let detail: unknown = e.detail;
      try {
        detail = JSON.parse(e.detail);
      } catch {
        // kept as text
      }
      return { ...e, detail };
    });
  switch (cmd) {
    case "invite": {
      const inv = store.createInvite(arg ?? "");
      const url = `${hubUrl}/_hub/invite/${inv.code}`;
      return out({ url, expiresAt: inv.expiresAt }, () => `${url}\nvalid until ${iso(inv.expiresAt)}, once`);
    }
    case "invites": {
      const list = store.invites();
      return out(list, () => list.map((i) => `${i.id}\t${i.note || "-"}\t${i.usedBy ? `used by ${i.usedBy}` : i.expiresAt > Date.now() ? `open until ${iso(i.expiresAt)}` : "expired"}`).join("\n"));
    }
    case "cancel-invite": {
      const ok = store.cancelInvite(id());
      return out({ ok }, () => (ok ? `invite ${arg} cancelled` : `no open invite ${arg}`));
    }
    case "users": {
      const list = store.users();
      return out(list, () => list.map((u) => `${u.id}\t${u.login}\t${u.disabled ? "DISABLED" : "active"}\t${iso(u.createdAt)}`).join("\n"));
    }
    case "devices": {
      const list = store.allDevices();
      return out(list, () => list.map((d) => `${d.id}\t${d.login}\t${d.name}\t${d.revoked ? "REVOKED" : "active"}\tlast seen ${iso(d.lastSeenAt)} ${d.lastIp ?? ""}`).join("\n"));
    }
    case "disable":
    case "enable": {
      const u = findUser();
      store.setDisabled(u.id, cmd === "disable");
      return out({ ok: true, login: u.login }, () => `${u.login} ${cmd}d${cmd === "disable" ? "; sessions ended, computers disconnected within 30 s" : ""}`);
    }
    case "revoke-device": {
      const ok = store.revokeDevice(id(), "operator");
      return out({ ok }, () => (ok ? `device ${arg} revoked; disconnected within 30 s` : `no active device ${arg}`));
    }
    case "audit": {
      const list = audit(Number(arg ?? 50) || 50);
      return out(list, () => list.map((e) => `${iso(e.at)}\tuser ${e.userId ?? "-"}\t${e.kind}\t${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}`).join("\n"));
    }
    case "overview": {
      // Everything the dashboard's Hub page shows, in one call (one SSH round trip).
      const value = { hubUrl, now: Date.now(), users: store.users(), devices: store.allDevices(), invites: store.invites(), audit: audit(40) };
      return out(value, () => `${hubUrl}\n${value.users.length} people, ${value.devices.filter((d) => !d.revoked).length} computers, ${value.invites.filter((i) => !i.usedBy && i.expiresAt > value.now).length} open invites`);
    }
    case "serve": {
      const hub = createHub({
        store,
        publicUrl: need("ORYS_HUB_URL"),
        github: githubOAuth(need("ORYS_GITHUB_CLIENT_ID"), need("ORYS_GITHUB_CLIENT_SECRET")),
        secure: env.ORYS_HUB_INSECURE !== "1",
        distPath: env.ORYS_HUB_DIST || undefined,
      });
      const port = Number(env.ORYS_HUB_PORT ?? 8080);
      const host = env.ORYS_HUB_HOST ?? "0.0.0.0";
      hub.server.listen(port, host, () => console.log(`${new Date().toISOString()} Orys hub on http://${host}:${port} for ${hubUrl}`));
      const stop = () => void hub.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    default:
      throw new Error("usage: server.ts [serve | overview | invite [note] | invites | cancel-invite <id> | users | devices | disable <login> | enable <login> | revoke-device <id> | audit [n]] [--json]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}

/**
 * Orys relay (SPEC §18): login + a pass-through from the browser to the agent
 * on the owner's computer. Stores nothing about projects.
 *
 * Standalone on purpose: it only imports node builtins and `ws` at runtime, so
 * the server can run it with `node server.ts` (type stripping), no build step.
 */
import { createHmac, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify, type KeyObject, type webcrypto } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentToRelay, RelayToAgent } from "./protocol.js";

/** A signing key from the Access certs URL. */
export type AccessJwk = webcrypto.JsonWebKey & { kid?: string };

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// Kept in sync with protocol.ts (runtime values can't be imported here, see header).
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range", "last-event-id", "user-agent"];
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"]);

const COOKIE = "orys_session";
const SESSION_DAYS = 30;
const MAX_BODY = 5 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 10;
/** Failed logins from all addresses together before every login pauses (many-IP guessing). */
const LOGIN_MAX_FAILS_GLOBAL = 30;
const PING_MS = 20_000;

/** On every response (SPEC §18.3). Relay pages and the engine's mockups bring a stricter CSP of their own. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  // The dashboard loads only its own files; markdown it renders cannot pull scripts or images from elsewhere.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/** Cloudflare Access in front of the relay (SPEC §18.3); the relay checks its token itself, so a request that skips Cloudflare gets nowhere. */
export type AccessOptions = {
  /** Zero Trust team name, "myteam" or "myteam.cloudflareaccess.com". */
  team: string;
  /** The Access application's audience (AUD) tag. */
  aud: string;
  /** Who may open the dashboard (lowercase emails); empty means anyone Access let through. */
  emails?: string[];
  /** The agent's service token Client ID; when set, only that token may connect an agent. */
  agentClientId?: string;
  /** Where the signing keys come from (tests); default: the team's certs URL. */
  fetchKeys?: () => Promise<AccessJwk[]>;
};

type AccessClaims = { email?: string; common_name?: string; aud?: string | string[]; iss?: string; exp?: number; nbf?: number };

export function accessVerifier(o: AccessOptions): (token: string) => Promise<AccessClaims> {
  const domain = o.team.includes(".") ? o.team : `${o.team}.cloudflareaccess.com`;
  const issuer = `https://${domain}`;
  const fetchKeys =
    o.fetchKeys ??
    (async () => {
      const r = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Access certs: HTTP ${r.status}`);
      return ((await r.json()) as { keys: AccessJwk[] }).keys;
    });
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let loading: Promise<void> | undefined;
  const refresh = () =>
    (loading ??= (async () => {
      try {
        const list = await fetchKeys();
        keys = new Map(list.filter((k) => typeof k.kid === "string").map((k) => [k.kid as string, createPublicKey({ key: k, format: "jwk" })]));
        fetchedAt = Date.now();
      } finally {
        loading = undefined;
      }
    })());
  const b64json = <T>(s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;
  return async (token) => {
    const [h, p, s, extra] = token.split(".");
    if (!h || !p || !s || extra !== undefined) throw new Error("malformed token");
    const header = b64json<{ alg?: string; kid?: string }>(h);
    if (header.alg !== "RS256" || !header.kid) throw new Error("unexpected token algorithm");
    // Cloudflare rotates keys; fetch again for an unknown key, at most once a minute.
    if (!keys.has(header.kid) && Date.now() - fetchedAt > 60_000) await refresh();
    const key = keys.get(header.kid);
    if (!key) throw new Error("unknown signing key");
    if (!verify("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw new Error("bad signature");
    const c = b64json<AccessClaims>(p);
    const now = Date.now() / 1000;
    if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(o.aud)) throw new Error("wrong audience");
    if (c.iss !== issuer) throw new Error("wrong issuer");
    if (typeof c.exp !== "number" || c.exp < now - 30) throw new Error("expired");
    if (typeof c.nbf === "number" && c.nbf > now + 30) throw new Error("not valid yet");
    return c;
  };
}

export type RelayOptions = {
  /** `scrypt:<salt b64>:<hash b64>`, made with `hashPassword`. */
  passwordHash: string;
  /** Secret for signing the session cookie. */
  secret: string;
  /** The agent authenticates with `Authorization: Bearer <agentToken>`. */
  agentToken: string;
  /** Set the cookie's Secure flag and HSTS (on behind HTTPS; off only for local tests). */
  secureCookie?: boolean;
  /** Require a valid Cloudflare Access token on every request (except /_relay/health). */
  access?: AccessOptions;
  log?: (line: string) => void;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltB64, hashB64] = stored.split(":");
  if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Pending = { res: ServerResponse; headersSent: boolean };

export function createRelay(opts: RelayOptions): { server: Server; agentConnected: () => boolean; close: () => Promise<void> } {
  const log = opts.log ?? ((l: string) => console.log(`${new Date().toISOString()} ${l}`));
  const secure = opts.secureCookie ?? true;
  let agent: WebSocket | undefined;
  let agentAlive = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const loginFails = new Map<string, { count: number; since: number }>();
  let globalFails: number[] = [];
  let globalLockLogged = false;
  const loginLocked = (ip: string) => {
    const now = Date.now();
    globalFails = globalFails.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (globalFails.length >= LOGIN_MAX_FAILS_GLOBAL) {
      if (!globalLockLogged) log(`ALERT: ${globalFails.length} failed logins in 15 minutes from all addresses; logins paused`);
      globalLockLogged = true;
      return true;
    }
    globalLockLogged = false;
    const f = loginFails.get(ip);
    return !!f && now - f.since < LOGIN_WINDOW_MS && f.count >= LOGIN_MAX_FAILS;
  };
  // The per-address map would otherwise only grow.
  const pruner = setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of loginFails) if (now - f.since >= LOGIN_WINDOW_MS) loginFails.delete(ip);
  }, 60_000);
  pruner.unref();

  // ---- Cloudflare Access --------------------------------------------------------
  const verifyAccess = opts.access ? accessVerifier(opts.access) : undefined;
  const accessEmails = (opts.access?.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  /** null when allowed, else why not (for the log). */
  const accessDenied = async (req: IncomingMessage, who: "browser" | "agent"): Promise<string | null> => {
    if (!verifyAccess) return null;
    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || !token) return "no Access token";
    let c: AccessClaims;
    try {
      c = await verifyAccess(token);
    } catch (e) {
      return `Access token rejected: ${(e as Error).message}`;
    }
    if (who === "agent") {
      if (!c.common_name) return "the agent must use a service token";
      if (opts.access?.agentClientId && c.common_name !== opts.access.agentClientId) return `service token ${c.common_name} is not the agent's`;
      return null;
    }
    const email = (c.email ?? "").toLowerCase();
    if (!email) return "a service token cannot open the dashboard";
    if (accessEmails.length && !accessEmails.includes(email)) return `${email} is not allowed`;
    return null;
  };

  // ---- sessions -----------------------------------------------------------
  const sign = (exp: number) => createHmac("sha256", opts.secret).update(`v1.${exp}`).digest("base64url");
  const newSession = () => {
    const exp = Date.now() + SESSION_DAYS * 86_400_000;
    return `${exp}.${sign(exp)}`;
  };
  const cookieHeader = (value: string, maxAgeSec: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  const isLoggedIn = (req: IncomingMessage) => {
    const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return false;
    const [expStr, sig] = raw.slice(COOKIE.length + 1).split(".");
    const exp = Number(expStr);
    if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
    return safeEqual(sig, sign(exp));
  };
  const clientIp = (req: IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    return !!origin && !!host && (origin === `https://${host}` || origin === `http://${host}`);
  };

  // ---- agent side -------------------------------------------------------------
  const failPending = (reason: string) => {
    for (const [id, p] of pending) {
      if (p.headersSent) p.res.destroy();
      else sendOffline(p.res, 502, reason);
      pending.delete(id);
    }
  };

  const onAgentFrame = (frame: AgentToRelay) => {
    if (frame.t === "hello") {
      log(`agent says hello: ${frame.agent} (protocol v${frame.version})`);
      return;
    }
    const p = pending.get(frame.id);
    if (!p) return;
    switch (frame.t) {
      case "head": {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(frame.headers)) if (!DROPPED_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
        p.res.writeHead(frame.status, headers);
        p.res.flushHeaders();
        p.headersSent = true;
        break;
      }
      case "chunk":
        p.res.write(Buffer.from(frame.data, "base64"));
        break;
      case "end":
        p.res.end();
        pending.delete(frame.id);
        break;
      case "error":
        if (p.headersSent) p.res.destroy();
        else sendJson(p.res, 502, { error: "agent_error", message: frame.message });
        pending.delete(frame.id);
        break;
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  wss.on("connection", (ws, req) => {
    if (agent) {
      log("a new agent connected; closing the previous one");
      agent.close(4000, "replaced");
      failPending("agent replaced");
    }
    agent = ws;
    agentAlive = true;
    log(`agent connected from ${clientIp(req)}`);
    ws.on("pong", () => (agentAlive = true));
    ws.on("message", (data) => {
      try {
        onAgentFrame(JSON.parse(String(data)) as AgentToRelay);
      } catch (e) {
        log(`bad frame from agent: ${(e as Error).message}`);
      }
    });
    ws.on("close", () => {
      if (agent !== ws) return;
      agent = undefined;
      log("agent disconnected");
      failPending("the computer went offline");
    });
  });
  const pinger = setInterval(() => {
    if (!agent) return;
    if (!agentAlive) {
      log("agent missed a ping; dropping it");
      agent.terminate();
      return;
    }
    agentAlive = false;
    agent.ping();
  }, PING_MS);

  const send = (frame: RelayToAgent) => agent?.send(JSON.stringify(frame));

  // ---- browser side -------------------------------------------------------------
  const server = createServer(async (req, res) => {
    // Defaults for every answer; a response may replace one with a stricter value (relay pages, mockups).
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
    try {
      await handle(req, res);
    } catch (e) {
      log(`error on ${req.method} ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "relay_error" });
      else res.destroy();
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname;

    if (path === "/_relay/health") return sendJson(res, 200, { ok: true });

    const denied = await accessDenied(req, "browser");
    if (denied) {
      log(`refused ${req.method} ${path} from ${clientIp(req)}: ${denied}`);
      return sendJson(res, 403, { error: "access_required" });
    }

    if (path === "/_relay/login") {
      if (req.method === "GET") return sendHtml(res, 200, loginPage(url.searchParams.has("failed")));
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "bad_origin" });
      const ip = clientIp(req);
      const fails = loginFails.get(ip);
      if (loginLocked(ip)) return sendHtml(res, 429, loginPage(false, "Too many attempts. Try again in 15 minutes."));
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString("utf8"));
      if (await verifyPassword(form.get("password") ?? "", opts.passwordHash)) {
        loginFails.delete(ip);
        log(`login ok from ${ip}`);
        res.writeHead(303, { location: "/", "set-cookie": cookieHeader(newSession(), SESSION_DAYS * 86_400), "cache-control": "no-store" });
        return res.end();
      }
      const f = fails && Date.now() - fails.since < LOGIN_WINDOW_MS ? fails : { count: 0, since: Date.now() };
      f.count++;
      loginFails.set(ip, f);
      globalFails.push(Date.now());
      log(`login failed from ${ip} (${f.count})`);
      res.writeHead(303, { location: "/_relay/login?failed", "cache-control": "no-store" });
      return res.end();
    }

    if (path === "/_relay/logout" && req.method === "POST") {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: "bad_origin" });
      res.writeHead(303, { location: "/_relay/login", "set-cookie": cookieHeader("", 0) });
      return res.end();
    }

    if (!isLoggedIn(req)) {
      const wantsHtml = (req.headers.accept ?? "").includes("text/html");
      if (req.method === "GET" && wantsHtml) {
        res.writeHead(303, { location: "/_relay/login", "cache-control": "no-store" });
        return res.end();
      }
      return sendJson(res, 401, { error: "login_required" });
    }

    if (path === "/_relay/status") return sendJson(res, 200, { agent: !!agent });

    const changesState = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (changesState && !sameOrigin(req)) return sendJson(res, 403, { error: "bad_origin" });

    if (!agent) return sendOffline(res, 503, "the computer is offline");

    const headers: Record<string, string> = {};
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const body = changesState ? await readBody(req, MAX_BODY) : undefined;
    const id = nextId++;
    pending.set(id, { res, headersSent: false });
    res.on("close", () => {
      if (pending.delete(id)) send({ t: "cancel", id });
    });
    send({ t: "req", id, method: req.method ?? "GET", url: req.url ?? "/", headers, body: body?.length ? body.toString("base64") : undefined });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (url.pathname !== "/_relay/agent" || !token || !safeEqual(token, opts.agentToken)) {
      log(`rejected agent connection from ${clientIp(req)}`);
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.on("error", () => socket.destroy());
    void accessDenied(req, "agent").then((denied) => {
      if (denied) {
        log(`rejected agent connection from ${clientIp(req)}: ${denied}`);
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  });

  return {
    server,
    agentConnected: () => !!agent,
    close: async () => {
      clearInterval(pinger);
      clearInterval(pruner);
      agent?.terminate();
      failPending("relay shutting down");
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

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(html);
}

function sendOffline(res: ServerResponse, status: number, reason: string) {
  const accept = res.req?.headers.accept ?? "";
  if (accept.includes("text/html")) return sendHtml(res, status, offlinePage());
  sendJson(res, status, { error: "agent_offline", message: reason });
}

const PAGE_STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--fg:#1b1b1a;--muted:#6b6a66;--line:#e3e1dc;--accent:#1b1b1a;--accent-fg:#fff;--bad:#b4371f}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1b1b1a;--fg:#ecebe7;--muted:#9a9893;--line:#2c2b29;--accent:#ecebe7;--accent-fg:#121211;--bad:#ef7a5f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}p{margin:0 0 20px;color:var(--muted)}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;margin-bottom:12px}
button,a.btn{display:block;width:100%;padding:10px 12px;border-radius:8px;border:0;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.err{color:var(--bad);margin:-4px 0 12px;font-size:14px}`;

function loginPage(failed: boolean, message?: string): string {
  const err = message ?? (failed ? "Wrong password." : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orys · Sign in</title><style>${PAGE_STYLE}</style></head>
<body><form class="card" method="post" action="/_relay/login"><h1>Orys</h1><p>Sign in to reach Orys on your computer.</p>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
${err ? `<div class="err">${err}</div>` : ""}<button type="submit">Sign in</button></form></body></html>`;
}

function offlinePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>Orys · Offline</title><style>${PAGE_STYLE}</style></head>
<body><div class="card"><h1>Your computer is offline</h1><p>Orys runs on your computer, and it is not connected right now: the computer is asleep or off, or remote access is turned off in the dashboard there. Nothing is lost. This page retries every 15 seconds.</p><a class="btn" href="/">Try again</a></div></body></html>`;
}

// ---- entry point: `node src/relay/server.ts` on the server --------------------------
async function main() {
  const env = process.env;
  if (process.argv[2] === "hash-password") {
    const pw = process.argv[3] ?? env.ORYS_RELAY_PASSWORD;
    if (!pw) throw new Error("usage: server.ts hash-password <password>");
    console.log(await hashPassword(pw));
    return;
  }
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const secureCookie = env.ORYS_RELAY_INSECURE_COOKIE !== "1";
  const access: AccessOptions | undefined =
    env.ORYS_ACCESS_TEAM && env.ORYS_ACCESS_AUD
      ? {
          team: env.ORYS_ACCESS_TEAM,
          aud: env.ORYS_ACCESS_AUD,
          emails: (env.ORYS_ACCESS_EMAILS ?? "").split(",").filter(Boolean),
          agentClientId: env.ORYS_ACCESS_AGENT_CLIENT_ID || undefined,
        }
      : undefined;
  // Fail closed: a public relay with only the password in front is not allowed by accident.
  if (!access && secureCookie && env.ORYS_RELAY_ALLOW_NO_ACCESS !== "1") {
    throw new Error("Cloudflare Access is not configured: set ORYS_ACCESS_TEAM and ORYS_ACCESS_AUD (deploy/relay/set-access.sh), or ORYS_RELAY_ALLOW_NO_ACCESS=1 to run behind the password only");
  }
  if (access && !access.emails?.length) console.log("warning: ORYS_ACCESS_EMAILS is empty; anyone the Access policy lets through can reach the login page");
  const relay = createRelay({
    passwordHash: need("ORYS_RELAY_PASSWORD_HASH"),
    secret: need("ORYS_RELAY_SECRET"),
    agentToken: need("ORYS_RELAY_AGENT_TOKEN"),
    secureCookie,
    access,
  });
  const port = Number(env.ORYS_RELAY_PORT ?? 8080);
  const host = env.ORYS_RELAY_HOST ?? "0.0.0.0";
  relay.server.listen(port, host, () => console.log(`${new Date().toISOString()} Orys relay on http://${host}:${port}`));
  const stop = () => void relay.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Compare real paths: on the server the file is reached through the `current` symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}

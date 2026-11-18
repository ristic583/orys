/**
 * Orys hub storage (SPEC §18.5): accounts, invites, sessions, devices, pairings, audit.
 * Built-in `node:sqlite`, so the hub runs on the server with Node alone (type stripping).
 * Every secret (invite, session, device token, pairing device code) is stored only as a
 * SHA-256 hash; the plain value exists once, in the response that hands it out.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const INVITE_DAYS = 7;
export const SESSION_DAYS = 7;
export const PAIRING_MINUTES = 10;
export const MAX_DEVICES = 3;
export const PAIR_MAX_FAILS = 5;
export const PAIR_LOCK_MS = 15 * 60_000;

/** Crockford base32 without I, L, O, U: 32 symbols, so 8 of them are 40 bits. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newSecret = () => randomBytes(32).toString("base64url");
export const newUserCode = () => {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
/** What people type: case, spaces, dashes and look-alikes (O→0, I/L→1) don't matter. */
export const normalizeUserCode = (s: string) => {
  const c = s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
};

export type User = { id: number; githubId: number; login: string; createdAt: number; disabled: boolean };
export type Device = { id: number; userId: number; name: string; createdAt: number; lastSeenAt: number | null; lastIp: string | null; revoked: boolean };
export type Session = { id: number; userId: number; deviceId: number | null; expiresAt: number; createdAt: number; ip: string | null; userAgent: string | null };
export type Invite = { id: number; note: string; createdAt: number; expiresAt: number; usedBy: string | null; usedAt: number | null };
export type Pairing = { id: number; userCode: string; name: string; ip: string | null; expiresAt: number; userId: number | null; approvedAt: number | null; tokenIssued: boolean };

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const user = (r: Row): User => ({ id: num(r.id), githubId: num(r.github_id), login: String(r.login), createdAt: num(r.created_at), disabled: !!r.disabled });
const device = (r: Row): Device => ({
  id: num(r.id),
  userId: num(r.user_id),
  name: String(r.name),
  createdAt: num(r.created_at),
  lastSeenAt: r.last_seen_at == null ? null : num(r.last_seen_at),
  lastIp: r.last_ip == null ? null : String(r.last_ip),
  revoked: !!r.revoked,
});
const session = (r: Row): Session => ({
  id: num(r.id),
  userId: num(r.user_id),
  deviceId: r.device_id == null ? null : num(r.device_id),
  expiresAt: num(r.expires_at),
  createdAt: num(r.created_at),
  ip: r.ip == null ? null : String(r.ip),
  userAgent: r.user_agent == null ? null : String(r.user_agent),
});
const pairing = (r: Row): Pairing => ({
  id: num(r.id),
  userCode: String(r.user_code),
  name: String(r.name),
  ip: r.ip == null ? null : String(r.ip),
  expiresAt: num(r.expires_at),
  userId: r.user_id == null ? null : num(r.user_id),
  approvedAt: r.approved_at == null ? null : num(r.approved_at),
  tokenIssued: !!r.token_issued,
});

export class HubStore {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  // No parameter properties: the server runs this file with Node's type stripping.
  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, github_id INTEGER UNIQUE NOT NULL, login TEXT NOT NULL, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), used_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
      CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, last_ip TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairings (id INTEGER PRIMARY KEY, device_code_hash TEXT UNIQUE NOT NULL, user_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, approved_at INTEGER, token_issued INTEGER NOT NULL DEFAULT 0, last_poll_at INTEGER);
      CREATE TABLE IF NOT EXISTS pair_fails (user_id INTEGER PRIMARY KEY, count INTEGER NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER, kind TEXT NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS install_tokens (id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
    `);
  }

  close() {
    this.db.close();
  }

  audit(userId: number | null, kind: string, detail: Record<string, unknown> = {}) {
    this.db.prepare("INSERT INTO audit (at, user_id, kind, detail) VALUES (?, ?, ?, ?)").run(this.now(), userId, kind, JSON.stringify(detail));
  }

  auditLog(limit = 50): { at: number; userId: number | null; kind: string; detail: string }[] {
    return (this.db.prepare("SELECT at, user_id, kind, detail FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      at: num(r.at),
      userId: r.user_id == null ? null : num(r.user_id),
      kind: String(r.kind),
      detail: String(r.detail),
    }));
  }

  // ---- invites ----------------------------------------------------------------
  createInvite(note = ""): { code: string; expiresAt: number } {
    const code = newSecret();
    const expiresAt = this.now() + INVITE_DAYS * 86_400_000;
    this.db.prepare("INSERT INTO invites (code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(code), note, this.now(), expiresAt);
    this.audit(null, "invite_created", { note });
    return { code, expiresAt };
  }

  /** The 50 newest invites, for the operator. The link itself is not stored, so it is not here. */
  invites(): Invite[] {
    return (this.db.prepare("SELECT i.*, u.login AS used_login FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.id DESC LIMIT 50").all() as Row[]).map((r) => ({
      id: num(r.id),
      note: String(r.note ?? ""),
      createdAt: num(r.created_at),
      expiresAt: num(r.expires_at),
      usedBy: r.used_login == null ? null : String(r.used_login),
      usedAt: r.used_at == null ? null : num(r.used_at),
    }));
  }

  /** An open invite stops working at once; a used or expired one is left as it is. */
  cancelInvite(id: number): boolean {
    const now = this.now();
    const r = this.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ? AND used_by IS NULL AND expires_at > ?").run(now, id, now);
    if (!Number(r.changes)) return false;
    this.audit(null, "invite_cancelled", { invite: id });
    return true;
  }

  /** True if the code is an open invite (not used, not expired). */
  inviteValid(code: string): boolean {
    const r = this.db.prepare("SELECT expires_at, used_by FROM invites WHERE code_hash = ?").get(sha256(code)) as Row | undefined;
    return !!r && r.used_by == null && num(r.expires_at) > this.now();
  }

  // ---- users --------------------------------------------------------------------
  userByGithub(githubId: number): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as Row | undefined;
    return r && user(r);
  }

  userById(id: number): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r && user(r);
  }

  userByLogin(login: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE lower(login) = lower(?)").get(login) as Row | undefined;
    return r && user(r);
  }

  users(): User[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as Row[]).map(user);
  }

  /** Spends the invite and opens the account, atomically; undefined if the invite is not valid. */
  redeemInvite(code: string, githubId: number, login: string): User | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inv = this.db.prepare("SELECT id, expires_at, used_by FROM invites WHERE code_hash = ?").get(sha256(code)) as Row | undefined;
      if (!inv || inv.used_by != null || num(inv.expires_at) <= this.now() || this.userByGithub(githubId)) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const r = this.db.prepare("INSERT INTO users (github_id, login, created_at) VALUES (?, ?, ?) RETURNING *").get(githubId, login, this.now()) as Row;
      this.db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?").run(r.id as number, this.now(), inv.id as number);
      this.db.exec("COMMIT");
      this.audit(num(r.id), "account_created", { login });
      return user(r);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  updateLogin(userId: number, login: string) {
    this.db.prepare("UPDATE users SET login = ? WHERE id = ?").run(login, userId);
  }

  /** Disabling ends every session and revokes every device of the account. */
  setDisabled(userId: number, disabled: boolean) {
    this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
    if (disabled) {
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.db.prepare("UPDATE devices SET revoked = 1 WHERE user_id = ?").run(userId);
    }
    this.audit(userId, disabled ? "account_disabled" : "account_enabled");
  }

  // ---- sessions -----------------------------------------------------------------
  createSession(userId: number, ip: string | null, userAgent: string | null): string {
    const token = newSecret();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), userId, this.now(), this.now() + SESSION_DAYS * 86_400_000, ip, (userAgent ?? "").slice(0, 200));
    this.audit(userId, "login", { ip });
    return token;
  }

  /** The live session and its (enabled) user, or undefined. */
  session(token: string | undefined): { session: Session; user: User } | undefined {
    if (!token || token.length > 100) return undefined;
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token)) as Row | undefined;
    if (!r) return undefined;
    const s = session(r);
    if (s.expiresAt <= this.now()) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
      return undefined;
    }
    const u = this.userById(s.userId);
    if (!u || u.disabled) return undefined;
    return { session: s, user: u };
  }

  sessionsOf(userId: number): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").all(userId, this.now()) as Row[]).map(session);
  }

  deleteSession(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  deleteOtherSessions(userId: number, keepSessionId: number) {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId);
    this.audit(userId, "sessions_revoked");
  }

  /** Pick the computer this browser session talks to; only the account's own, live devices. */
  selectDevice(sessionId: number, userId: number, deviceId: number): boolean {
    const d = this.device(deviceId);
    if (!d || d.userId !== userId || d.revoked) return false;
    this.db.prepare("UPDATE sessions SET device_id = ? WHERE id = ? AND user_id = ?").run(deviceId, sessionId, userId);
    return true;
  }

  // ---- devices ------------------------------------------------------------------
  device(id: number): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r && device(r);
  }

  devicesOf(userId: number): Device[] {
    return (this.db.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked = 0 ORDER BY id").all(userId) as Row[]).map(device);
  }

  allDevices(): (Device & { login: string })[] {
    return (this.db.prepare("SELECT d.*, u.login FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.id").all() as Row[]).map((r) => ({ ...device(r), login: String(r.login) }));
  }

  /** The device a token belongs to, if neither it nor its account is revoked. */
  deviceByToken(token: string): Device | undefined {
    if (!token || token.length > 100) return undefined;
    const r = this.db.prepare("SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND d.revoked = 0 AND u.disabled = 0").get(sha256(token)) as Row | undefined;
    return r && device(r);
  }

  touchDevice(id: number, ip: string | null) {
    this.db.prepare("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?").run(this.now(), ip, id);
  }

  /** Only the owner of the device (or the operator, `asOperator`) may revoke it. */
  revokeDevice(id: number, byUserId: number | "operator"): boolean {
    const d = this.device(id);
    if (!d || d.revoked || (byUserId !== "operator" && d.userId !== byUserId)) return false;
    this.db.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
    this.db.prepare("UPDATE sessions SET device_id = NULL WHERE device_id = ?").run(id);
    this.audit(d.userId, "device_revoked", { device: id, by: byUserId });
    return true;
  }

  // ---- installing Orys (invited people only) ------------------------------------------
  /** A one-time download token for the install command, valid for an hour. */
  createInstallToken(userId: number): string {
    const token = newSecret();
    this.db.prepare("INSERT INTO install_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, this.now(), this.now() + 3_600_000);
    return token;
  }

  /** The account behind an unused, unexpired install token; `spend` uses it up (the download). */
  installToken(token: string, spend: boolean): number | undefined {
    if (!token || token.length > 100) return undefined;
    const r = this.db.prepare("SELECT t.id, t.user_id, t.expires_at, t.used_at FROM install_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.disabled = 0").get(sha256(token)) as Row | undefined;
    if (!r || r.used_at != null || num(r.expires_at) <= this.now()) return undefined;
    if (spend) {
      const done = this.db.prepare("UPDATE install_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(this.now(), num(r.id));
      if (Number(done.changes) !== 1) return undefined;
      this.audit(num(r.user_id), "orys_downloaded");
    }
    return num(r.user_id);
  }

  // ---- pairing (like the OAuth device flow) ------------------------------------------
  startPairing(name: string, ip: string | null): { deviceCode: string; userCode: string; expiresAt: number } {
    this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(this.now());
    const deviceCode = newSecret();
    const expiresAt = this.now() + PAIRING_MINUTES * 60_000;
    for (;;) {
      const userCode = newUserCode();
      try {
        this.db
          .prepare("INSERT INTO pairings (device_code_hash, user_code, name, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(sha256(deviceCode), userCode, name.slice(0, 60), ip, this.now(), expiresAt);
        return { deviceCode, userCode, expiresAt };
      } catch (e) {
        if (!/UNIQUE/.test((e as Error).message)) throw e;
      }
    }
  }

  private pairFailsLocked(userId: number): boolean {
    const r = this.db.prepare("SELECT count, since FROM pair_fails WHERE user_id = ?").get(userId) as Row | undefined;
    return !!r && num(r.count) >= PAIR_MAX_FAILS && this.now() - num(r.since) < PAIR_LOCK_MS;
  }

  private pairFailed(userId: number) {
    const r = this.db.prepare("SELECT count, since FROM pair_fails WHERE user_id = ?").get(userId) as Row | undefined;
    const fresh = !r || this.now() - num(r.since) >= PAIR_LOCK_MS;
    this.db
      .prepare("INSERT INTO pair_fails (user_id, count, since) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET count = excluded.count, since = excluded.since")
      .run(userId, fresh ? 1 : num(r!.count) + 1, fresh ? this.now() : num(r!.since));
  }

  /** A logged-in user looks up a code they typed (to show what they are approving). */
  findPairing(userId: number, typed: string): { ok: true; pairing: Pairing } | { ok: false; reason: "locked" | "invalid" } {
    if (this.pairFailsLocked(userId)) return { ok: false, reason: "locked" };
    const code = normalizeUserCode(typed);
    const r = code ? (this.db.prepare("SELECT * FROM pairings WHERE user_code = ?").get(code) as Row | undefined) : undefined;
    const p = r && pairing(r);
    if (!p || p.expiresAt <= this.now() || p.approvedAt != null) {
      this.pairFailed(userId);
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, pairing: p };
  }

  approvePairing(userId: number, typed: string): { ok: true; pairing: Pairing } | { ok: false; reason: "locked" | "invalid" | "too_many_devices" } {
    const found = this.findPairing(userId, typed);
    if (!found.ok) return found;
    if (this.devicesOf(userId).length >= MAX_DEVICES) return { ok: false, reason: "too_many_devices" };
    this.db.prepare("UPDATE pairings SET user_id = ?, approved_at = ? WHERE id = ? AND approved_at IS NULL").run(userId, this.now(), found.pairing.id);
    this.db.prepare("DELETE FROM pair_fails WHERE user_id = ?").run(userId);
    this.audit(userId, "pairing_approved", { name: found.pairing.name, ip: found.pairing.ip });
    return { ok: true, pairing: { ...found.pairing, userId, approvedAt: this.now() } };
  }

  /**
   * The agent polls with its device code. Once approved, it gets its device token exactly once.
   * `slow_down` when polled faster than every `minIntervalMs`.
   */
  pollPairing(deviceCode: string, minIntervalMs = 3_000): { status: "pending" | "slow_down" | "expired" } | { status: "approved"; token: string; deviceId: number } {
    if (!deviceCode || deviceCode.length > 100) return { status: "expired" };
    const r = this.db.prepare("SELECT * FROM pairings WHERE device_code_hash = ?").get(sha256(deviceCode)) as Row | undefined;
    if (!r) return { status: "expired" };
    const p = pairing(r);
    if (p.tokenIssued || p.expiresAt <= this.now()) return { status: "expired" };
    const last = r.last_poll_at == null ? 0 : num(r.last_poll_at);
    this.db.prepare("UPDATE pairings SET last_poll_at = ? WHERE id = ?").run(this.now(), p.id);
    if (this.now() - last < minIntervalMs) return { status: "slow_down" };
    if (p.approvedAt == null || p.userId == null) return { status: "pending" };
    const token = newSecret();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.db.prepare("UPDATE pairings SET token_issued = 1 WHERE id = ? AND token_issued = 0").run(p.id);
      if (Number(claimed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return { status: "expired" };
      }
      const d = this.db
        .prepare("INSERT INTO devices (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id")
        .get(p.userId, p.name, sha256(token), this.now()) as Row;
      this.db.exec("COMMIT");
      this.audit(p.userId, "device_paired", { device: num(d.id), name: p.name });
      return { status: "approved", token, deviceId: num(d.id) };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

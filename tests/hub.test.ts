/** Orys hub (SPEC §18.5): invite-only accounts, pairing, and isolation between accounts, tested as attacks. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startAgent, type AgentHandle } from "../src/relay/agent.js";
import { createHub, type GithubClient, type GithubUser } from "../src/hub/server.ts";
import { hubBase, pairWithHub, refuseToReplace } from "../src/relay/pairing.js";
import { HubStore, MAX_DEVICES, normalizeUserCode } from "../src/hub/store.ts";

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

/** A stand-in for one person's `orys serve`. */
async function engine(owner: string) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/api/projects?slow=1") return setTimeout(() => res.end(JSON.stringify({ owner, slow: true })), 300);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ owner, url: req.url }));
  });
  const port = await listen(server);
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { url: `http://127.0.0.1:${port}`, seen };
}

async function setupHub(now?: () => number, distPath?: string) {
  const store = new HubStore(":memory:", now);
  const codes = new Map<string, GithubUser>();
  const github: GithubClient = {
    authorizeUrl: (state) => `https://github.test/authorize?state=${state}`,
    userFromCode: async (code) => {
      const u = codes.get(code);
      if (!u) throw new Error("bad code");
      return u;
    },
  };
  // The public URL must match the port, which is only known after listen: start on a fixed free port.
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const hub = createHub({ store, publicUrl: base, github, secure: false, log: () => {}, distPath });
  await new Promise<void>((r) => hub.server.listen(port, "127.0.0.1", () => r()));
  cleanups.push(() => hub.close());

  /** Signs a GitHub account in through the real flow; returns the session cookie (or the refusal). */
  const signIn = async (gh: GithubUser, invitePath?: string) => {
    const jar: string[] = [];
    const keep = (r: Response) => {
      for (const c of r.headers.getSetCookie()) {
        const kv = c.split(";")[0]!;
        const name = kv.split("=")[0]!;
        const i = jar.findIndex((x) => x.startsWith(`${name}=`));
        if (i >= 0) jar.splice(i, 1);
        if (!/Max-Age=0/.test(c)) jar.push(kv);
      }
    };
    if (invitePath) keep(await fetch(`${base}${invitePath}`, { redirect: "manual" }));
    const start = await fetch(`${base}/_hub/login`, { redirect: "manual", headers: { cookie: jar.join("; ") } });
    keep(start);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    codes.set(`c-${gh.id}`, gh);
    const back = await fetch(`${base}/_hub/auth/github?code=c-${gh.id}&state=${state}`, { redirect: "manual", headers: { cookie: jar.join("; ") } });
    keep(back);
    const session = jar.find((c) => c.startsWith("orys_hub="));
    return { status: back.status, cookie: session ?? "", text: back.status === 303 ? "" : await back.text() };
  };
  const invitePath = () => `/_hub/invite/${store.createInvite("test").code}`;
  const form = (cookie: string, path: string, fields: Record<string, string>, origin = base) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  /** The agent side of pairing, plus the user approving it in the browser; returns the device token. */
  const pair = async (cookie: string, name: string) => {
    const start = (await (await fetch(`${base}/_hub/api/pair/start`, { method: "POST", body: JSON.stringify({ name }) })).json()) as { device_code: string; user_code: string };
    expect((await form(cookie, "/_hub/pair", { code: start.user_code, approve: "yes" })).status).toBe(200);
    const poll = (await (await fetch(`${base}/_hub/api/pair/poll`, { method: "POST", body: JSON.stringify({ device_code: start.device_code }) })).json()) as { status: string; token: string };
    expect(poll.status).toBe("approved");
    return { token: poll.token, deviceCode: start.device_code };
  };
  const connect = (token: string, target: string) => {
    const agent: AgentHandle = startAgent({ relayUrl: `${base.replace("http", "ws")}/_hub/agent`, token, target, log: () => {} });
    cleanups.push(() => agent.stop());
    return agent;
  };
  return { store, hub, base, signIn, invitePath, form, pair, connect };
}

describe("hub: accounts are invite-only (T3)", () => {
  it("a GitHub account without an invite gets nothing; with one it gets an account, once", async () => {
    const { store, signIn, invitePath, base } = await setupHub();
    const stranger = await signIn({ id: 1, login: "stranger" });
    expect(stranger.status).toBe(403);
    expect(stranger.text).toContain("invite-only");
    expect(store.users()).toHaveLength(0);

    const inv = invitePath();
    const alice = await signIn({ id: 2, login: "alice" }, inv);
    expect(alice.status).toBe(303);
    expect(alice.cookie).toMatch(/^orys_hub=/);
    // The same invite does not open a second account.
    expect((await signIn({ id: 3, login: "mallory" }, inv)).status).toBe(403);
    expect((await fetch(`${base}${inv}`)).status).toBe(410);
    // Alice signs in again later without an invite.
    expect((await signIn({ id: 2, login: "alice" })).status).toBe(303);
    expect(store.users().map((u) => u.login)).toEqual(["alice"]);
  });

  it("an invite expires after 7 days", async () => {
    let now = Date.now();
    const { signIn, invitePath } = await setupHub(() => now);
    const inv = invitePath();
    now += 7 * 86_400_000 + 1;
    expect((await signIn({ id: 2, login: "alice" }, inv)).status).toBe(403);
  });

  it("refuses a callback whose state was not started here", async () => {
    const { base } = await setupHub();
    const r = await fetch(`${base}/_hub/auth/github?code=x&state=forged`, { headers: { cookie: "orys_oauth=other" }, redirect: "manual" });
    expect(r.status).toBe(400);
  });

  it("nothing passes without a session", async () => {
    const { base } = await setupHub();
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
    const page = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(page.headers.get("location")).toBe("/_hub/");
  });
});

describe("hub: pairing (T5, T6)", () => {
  it("pairs a computer; the token is handed out once; wrong codes lock; three computers at most", async () => {
    const { store, signIn, invitePath, form, pair, base } = await setupHub();
    const { cookie } = await signIn({ id: 2, login: "alice" }, invitePath());
    const { deviceCode } = await pair(cookie, "alice-mac");
    // The device code cannot be used again for a second token.
    expect((await fetch(`${base}/_hub/api/pair/poll`, { method: "POST", body: JSON.stringify({ device_code: deviceCode }) })).status).toBe(410);

    for (let i = 0; i < 5; i++) expect((await form(cookie, "/_hub/pair", { code: "ZZZZ-ZZZZ" })).status).toBe(400);
    expect((await form(cookie, "/_hub/pair", { code: "ZZZZ-ZZZZ" })).status).toBe(429);
    store.db.prepare("DELETE FROM pair_fails").run();

    await pair(cookie, "alice-2");
    await pair(cookie, "alice-3");
    const start = (await (await fetch(`${base}/_hub/api/pair/start`, { method: "POST", body: JSON.stringify({ name: "alice-4" }) })).json()) as { user_code: string };
    expect(await (await form(cookie, "/_hub/pair", { code: start.user_code, approve: "yes" })).text()).toContain(`already have ${MAX_DEVICES} computers`);
  });

  it("codes are forgiving to type but still 40 bits", () => {
    expect(normalizeUserCode(" abcd efgh ")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("0OIL-1234")).toBe("0011-1234");
    expect(normalizeUserCode("ABC")).toBeNull();
  });

  it("a computer name cannot inject markup into the pages", async () => {
    const { signIn, invitePath, pair, base } = await setupHub();
    const { cookie } = await signIn({ id: 2, login: "alice" }, invitePath());
    await pair(cookie, `<script>alert(1)</script><img src=x onerror=alert(2)>`);
    const page = await (await fetch(`${base}/_hub/devices`, { headers: { cookie } })).text();
    expect(page).not.toMatch(/<script>|<img/);
  });
});

describe("hub: one account never reaches another's computer (T2)", () => {
  async function twoPeople() {
    const h = await setupHub();
    const alice = await h.signIn({ id: 2, login: "alice" }, h.invitePath());
    const bob = await h.signIn({ id: 3, login: "bob" }, h.invitePath());
    const aliceEngine = await engine("alice");
    const bobEngine = await engine("bob");
    const a = await h.pair(alice.cookie, "alice-mac");
    const b = await h.pair(bob.cookie, "bob-mac");
    const aliceAgent = h.connect(a.token, aliceEngine.url);
    const bobAgent = h.connect(b.token, bobEngine.url);
    await until(() => aliceAgent.connected() && bobAgent.connected());
    const aliceDevice = h.store.devicesOf(h.store.userByLogin("alice")!.id)[0]!;
    const bobDevice = h.store.devicesOf(h.store.userByLogin("bob")!.id)[0]!;
    return { ...h, alice, bob, aliceEngine, bobEngine, aliceDevice, bobDevice, aliceToken: a.token };
  }
  const get = (base: string, cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });

  it("each person reaches only their own computer", async () => {
    const { base, alice, bob, aliceEngine, bobEngine } = await twoPeople();
    expect(await (await get(base, alice.cookie, "/api/projects")).json()).toMatchObject({ owner: "alice" });
    expect(await (await get(base, bob.cookie, "/api/projects")).json()).toMatchObject({ owner: "bob" });
    expect(aliceEngine.seen).toEqual(["GET /api/projects"]);
    expect(bobEngine.seen).toEqual(["GET /api/projects"]);
  });

  it("picking someone else's computer is refused, and a forged selection in the database still does not route", async () => {
    const { base, store, alice, form, bobDevice, bobEngine } = await twoPeople();
    expect((await form(alice.cookie, "/_hub/devices/select", { id: String(bobDevice.id) })).status).toBe(404);
    store.db.prepare("UPDATE sessions SET device_id = ? WHERE user_id = ?").run(bobDevice.id, store.userByLogin("alice")!.id);
    const r = await get(base, alice.cookie, "/api/projects");
    expect(r.status).toBe(409);
    expect(bobEngine.seen).toEqual([]);
  });

  it("someone else's computer cannot be removed", async () => {
    const { alice, form, store, bobDevice, hub } = await twoPeople();
    await form(alice.cookie, "/_hub/devices/revoke", { id: String(bobDevice.id) });
    expect(store.device(bobDevice.id)!.revoked).toBe(false);
    expect(hub.online(bobDevice.id)).toBe(true);
  });

  it("a rogue agent cannot answer requests meant for another computer", async () => {
    const { base, bob, aliceToken } = await twoPeople();
    // Alice's token, used by a hand-written client that floods answers for every request id.
    const rogue = new WebSocket(`${base.replace("http", "ws")}/_hub/agent`, { headers: { authorization: `Bearer ${aliceToken}` } });
    await new Promise((r) => rogue.on("open", r));
    cleanups.push(() => rogue.close());
    const pending = get(base, bob.cookie, "/api/projects?slow=1");
    for (let id = 1; id <= 200; id++) {
      rogue.send(JSON.stringify({ t: "head", id, status: 200, headers: { "content-type": "text/plain" } }));
      rogue.send(JSON.stringify({ t: "chunk", id, data: Buffer.from("pwned").toString("base64") }));
      rogue.send(JSON.stringify({ t: "end", id }));
    }
    expect(await (await pending).json()).toEqual({ owner: "bob", slow: true });
  });

  it("removing a computer disconnects it at once; its token stops working", async () => {
    const { base, alice, form, store, aliceDevice, hub, aliceToken } = await twoPeople();
    await form(alice.cookie, "/_hub/devices/revoke", { id: String(aliceDevice.id) });
    expect(hub.online(aliceDevice.id)).toBe(false);
    expect(store.deviceByToken(aliceToken)).toBeUndefined();
    expect((await get(base, alice.cookie, "/api/projects")).status).toBe(409);
  });

  it("a disabled account loses its sessions at once and its computers on the next check", async () => {
    const { base, alice, store, aliceDevice, hub } = await twoPeople();
    store.setDisabled(store.userByLogin("alice")!.id, true);
    expect((await get(base, alice.cookie, "/api/projects")).status).toBe(401);
    hub.recheck();
    expect(hub.online(aliceDevice.id)).toBe(false);
  });

  it("cross-site writes are refused (CSRF)", async () => {
    const { base, alice, form, store, aliceDevice } = await twoPeople();
    expect((await form(alice.cookie, "/_hub/devices/revoke", { id: String(aliceDevice.id) }, "https://evil.example")).status).toBe(403);
    expect(store.device(aliceDevice.id)!.revoked).toBe(false);
    const post = await fetch(`${base}/api/probe`, { method: "POST", headers: { cookie: alice.cookie, origin: "https://evil.example" } });
    expect(post.status).toBe(403);
  });

  it("the remote policy on each computer still applies through the hub", async () => {
    const { base, alice, aliceEngine } = await twoPeople();
    const r = await fetch(`${base}/api/remote/enable`, { method: "POST", headers: { cookie: alice.cookie, origin: base } });
    expect(r.status).toBe(403);
    expect(aliceEngine.seen).toEqual([]);
  });
});

describe("hub: sessions (T4)", () => {
  it("signing out elsewhere ends the other sessions; sign-out ends this one", async () => {
    const { signIn, invitePath, form, base } = await setupHub();
    const inv = invitePath();
    const first = await signIn({ id: 2, login: "alice" }, inv);
    const second = await signIn({ id: 2, login: "alice" });
    expect((await fetch(`${base}/_hub/devices`, { headers: { cookie: first.cookie } })).status).toBe(200);
    await form(second.cookie, "/_hub/sessions/revoke-others", {});
    expect((await fetch(`${base}/_hub/devices`, { headers: { cookie: first.cookie } })).status).toBe(401);
    await form(second.cookie, "/_hub/logout", {});
    expect((await fetch(`${base}/_hub/devices`, { headers: { cookie: second.cookie } })).status).toBe(401);
  });
});

describe("invites the owner cancels", () => {
  it("a cancelled invite opens no account; a used one cannot be cancelled", () => {
    const store = new HubStore(":memory:");
    const a = store.createInvite("for Ana");
    const b = store.createInvite("for Bo");
    const [ib, ia] = store.invites();
    expect(store.cancelInvite(ia!.id)).toBe(true);
    expect(store.cancelInvite(ia!.id)).toBe(false);
    expect(store.inviteValid(a.code)).toBe(false);
    expect(store.redeemInvite(a.code, 1, "ana")).toBeUndefined();
    expect(store.redeemInvite(b.code, 2, "bo")?.login).toBe("bo");
    expect(store.cancelInvite(ib!.id)).toBe(false);
    expect(store.invites().find((i) => i.id === ib!.id)?.usedBy).toBe("bo");
  });
});

describe("hub and relay run on the server with Node alone (type stripping, no build)", () => {
  it("the operator commands work under plain node", () => {
    const env = { ...process.env, ORYS_HUB_DB: join(mkdtempSync(join(tmpdir(), "hub-")), "hub.db"), ORYS_HUB_URL: "https://hub.example" };
    expect(execFileSync("node", ["src/hub/server.ts", "invite", "x"], { env, encoding: "utf8" })).toMatch(/^https:\/\/hub\.example\/_hub\/invite\/[A-Za-z0-9_-]{43}\n/);
    expect(execFileSync("node", ["src/hub/server.ts", "audit"], { env, encoding: "utf8" })).toContain("invite_created");
    // --json is what the owner's Hub page reads (src/server/hubAdmin.ts).
    const overview = JSON.parse(execFileSync("node", ["src/hub/server.ts", "overview", "--json"], { env, encoding: "utf8" }));
    expect(overview).toMatchObject({ hubUrl: "https://hub.example", users: [], devices: [], invites: [{ id: 1, note: "x", usedBy: null }] });
    expect(JSON.parse(execFileSync("node", ["src/hub/server.ts", "cancel-invite", "1", "--json"], { env, encoding: "utf8" }))).toEqual({ ok: true });
    expect(execFileSync("node", ["src/relay/server.ts", "hash-password", "pw"], { encoding: "utf8" })).toMatch(/^scrypt:/);
  });
});

describe("orys agent login (pairing from the computer)", () => {
  it("pairs end to end: the code is confirmed in the browser, the computer gets its token and connects", async () => {
    const h = await setupHub();
    const alice = await h.signIn({ id: 2, login: "alice" }, h.invitePath());
    const shown: string[] = [];
    const paired = await pairWithHub({
      hub: h.base,
      name: "alice-mac",
      sleep: async () => {},
      show: (code, url) => {
        shown.push(code, url);
        void h.form(alice.cookie, "/_hub/pair", { code, approve: "yes" });
      },
    });
    expect(shown[1]).toBe(`${h.base}/_hub/pair?code=${shown[0]}`);
    expect(paired.relay).toBe(`${h.base.replace("http", "ws")}/_hub/agent`);
    const e = await engine("alice");
    const agent = h.connect(paired.token, e.url);
    await until(agent.connected);
    expect(await (await fetch(`${h.base}/api/projects`, { headers: { cookie: alice.cookie } })).json()).toMatchObject({ owner: "alice" });
  });

  it("only https hubs; the owner's private relay is not replaced without --force", () => {
    expect(() => hubBase("http://orys.example.com")).toThrow(/https/);
    expect(hubBase("http://127.0.0.1:5000/x").toString()).toBe("http://127.0.0.1:5000/");
    const hub = new URL("https://hub.example");
    const privateRelay = { relay: "wss://orys.example.com/_relay/agent", token: "t", accessClientId: "c", accessClientSecret: "s" };
    expect(refuseToReplace(privateRelay, hub, false)).toMatch(/private relay behind Cloudflare Access/);
    expect(refuseToReplace(privateRelay, hub, true)).toBeNull();
    expect(refuseToReplace({}, hub, false)).toBeNull();
    expect(refuseToReplace({ relay: "wss://hub.example/_hub/agent", token: "t" }, hub, false)).toBeNull(); // re-pairing
  });
});

describe("hub: installing Orys (invited people only)", () => {
  it("a signed-in person gets a one-time command; the package downloads once; strangers get nothing", async () => {
    const dist = join(mkdtempSync(join(tmpdir(), "dist-")), "orys.tgz");
    writeFileSync(dist, "fake package");
    const h = await setupHub(undefined, dist);
    expect((await fetch(`${h.base}/_hub/install`)).status).toBe(401);
    expect((await fetch(`${h.base}/_hub/dist/orys.tgz?t=guess`)).status).toBe(410);

    const alice = await h.signIn({ id: 2, login: "alice" }, h.invitePath());
    const page = await (await fetch(`${h.base}/_hub/install`, { headers: { cookie: alice.cookie } })).text();
    const t = /install\.sh\?t=([A-Za-z0-9_-]+)/.exec(page)![1]!;
    const script = await (await fetch(`${h.base}/_hub/install.sh?t=${t}`)).text();
    expect(script).toContain(`HUB='${h.base}'`);
    expect(script).toContain("agent login --hub");
    expect(await (await fetch(`${h.base}/_hub/dist/orys.tgz?t=${t}`)).text()).toBe("fake package");
    expect((await fetch(`${h.base}/_hub/dist/orys.tgz?t=${t}`)).status).toBe(410); // once
    expect((await fetch(`${h.base}/_hub/install.sh?t=${t}`)).status).toBe(410);
  });
});

describe("hub: device-code phishing (T6)", () => {
  it("warns when the code was started from another network than the person approving it", async () => {
    const h = await setupHub();
    const alice = await h.signIn({ id: 2, login: "alice" }, h.invitePath());
    const start = async (ip: string) =>
      ((await (await fetch(`${h.base}/_hub/api/pair/start`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ name: "x" }) })).json()) as { user_code: string }).user_code;
    const confirmPage = async (code: string, ip: string) =>
      (await fetch(`${h.base}/_hub/pair`, { method: "POST", headers: { cookie: alice.cookie, origin: h.base, "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}` })).text();
    expect(await confirmPage(await start("198.51.100.9"), "203.0.113.5")).toContain("If someone sent you this code, do not continue");
    expect(await confirmPage(await start("203.0.113.5"), "203.0.113.5")).not.toContain("Careful");
  });
});

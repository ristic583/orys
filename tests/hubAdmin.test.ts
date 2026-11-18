/** The owner's Hub page (SPEC §18.5): only fixed commands reach the hub, over SSH, and only on the owner's Mac. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.ts";
import { remoteDecision } from "../src/relay/policy.js";
import { buildServer } from "../src/server/index.js";
import { cleanNote, commandArgs, HubInputError, localHubAdmin, shq, sshArgs, sshHubAdmin, type HubCommand } from "../src/server/hubAdmin.js";
import { setup } from "./helpers.js";

describe("hub admin: what may be sent", () => {
  it("refuses anything that is not an id or a GitHub login, before anything runs", () => {
    for (const bad of ["-oProxyCommand=touch /tmp/x", "a;reboot", "a b", "$(id)", "", "x".repeat(40), "-a"]) {
      expect(() => commandArgs(["disable", bad])).toThrow(HubInputError);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(() => commandArgs(["revoke-device", bad])).toThrow(HubInputError);
    expect(() => commandArgs(["serve" as never] as unknown as HubCommand)).toThrow(HubInputError);
    expect(commandArgs(["enable", "ana-dev"])).toEqual(["enable", "ana-dev"]);
    expect(commandArgs(["cancel-invite", 7])).toEqual(["cancel-invite", "7"]);
  });

  it("the note keeps letters (any language) and drops shell characters", () => {
    expect(cleanNote("  za Anu — Šabac ")).toBe("za Anu Šabac");
    expect(cleanNote("x'; rm -rf / #`$(id)`")).toBe("x rm -rf (id)"); // inside single quotes, ( ) are plain text
    expect(cleanNote("a".repeat(100))).toHaveLength(60);
  });

  it("builds one ssh command: batch mode, through the jump host, every argument quoted", () => {
    expect(sshArgs({ jump: "admin@bastion.example.com", host: "orys@hub.internal.example" }, ["invite", "za Anu"])).toEqual([
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-J", "admin@bastion.example.com", "orys@hub.internal.example",
      "sudo", "-n", "orys-hub", "'invite'", "'za Anu'", "--json",
    ]);
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(() => sshHubAdmin({ host: "-oProxyCommand=x" })).toThrow(/not an SSH target/);
    expect(() => sshHubAdmin({ host: "orys@hub.internal.example", jump: "root@host;id" })).toThrow(/not an SSH target/);
  });

  it("says when the hub cannot be reached, and never trusts a non-JSON answer", async () => {
    const calls: string[][] = [];
    const down = sshHubAdmin({ jump: "admin@bastion.example.com", host: "orys@hub.internal.example" }, async (file, args) => {
      calls.push([file, ...args]);
      return { code: 255, stdout: "", stderr: "ssh: connect to host bastion.example.com port 22: Operation timed out\n" };
    });
    await expect(down.run(["overview"])).rejects.toThrow("Could not reach the hub over SSH from this Mac: ssh: connect to host bastion.example.com port 22: Operation timed out");
    expect(calls[0]![0]).toBe("ssh");
    const odd = sshHubAdmin({ host: "orys@hub.internal.example" }, async () => ({ code: 0, stdout: "<html>", stderr: "" }));
    await expect(odd.run(["overview"])).rejects.toThrow(/not JSON/);
  });
});

describe("hub admin: the Hub page's API on the owner's engine", () => {
  it("invites, lists, cancels, blocks and removes computers on a real hub database", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "hub-admin-")), "hub.db");
    const seed = new HubStore(dbPath);
    const ana = seed.redeemInvite(seed.createInvite("za Anu").code, 101, "ana-dev")!;
    const pairing = seed.startPairing("ana-laptop", "198.51.100.7");
    expect(seed.approvePairing(ana.id, pairing.userCode).ok).toBe(true);
    expect(seed.pollPairing(pairing.deviceCode, 0).status).toBe("approved");
    const deviceId = seed.devicesOf(ana.id)[0]!.id;
    seed.db.close();

    const { db, deps, config } = await setup([], { planned: false });
    const server = buildServer({ app: { ...deps, db, config }, webDir: null, hubAdmin: localHubAdmin({ db: dbPath, url: "https://hub.example" }) });
    const call = async (method: "GET" | "POST", url: string, payload?: object) => {
      const r = await server.inject({ method, url, payload: method === "POST" ? (payload ?? {}) : undefined });
      return { status: r.statusCode, body: r.json() };
    };

    expect((await call("GET", "/api/status")).body.hubAdmin).toBe(true);
    const first = await call("GET", "/api/hub-admin");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ hubUrl: "https://hub.example", via: `local ${dbPath}`, users: [{ login: "ana-dev", disabled: false }] });

    const inv = await call("POST", "/api/hub-admin/invite", { note: "za Marka; rm -rf /" });
    expect(inv.body.url).toMatch(/^https:\/\/hub\.example\/_hub\/invite\/[A-Za-z0-9_-]{43}$/);
    const open = (await call("GET", "/api/hub-admin")).body.invites.find((i: { note: string }) => i.note === "za Marka rm -rf");
    expect(open).toBeDefined();
    expect((await call("POST", `/api/hub-admin/invites/${open.id}/cancel`)).body).toEqual({ ok: true });
    expect((await call("POST", `/api/hub-admin/invites/${open.id}/cancel`)).body).toEqual({ ok: false });

    expect((await call("POST", "/api/hub-admin/devices/abc/revoke")).status).toBe(400);
    expect((await call("POST", "/api/hub-admin/devices/99/revoke")).body).toEqual({ ok: false });
    expect((await call("GET", "/api/hub-admin")).body.devices).toMatchObject([{ id: deviceId, login: "ana-dev", name: "ana-laptop", revoked: false }]);
    expect((await call("POST", `/api/hub-admin/devices/${deviceId}/revoke`)).body).toEqual({ ok: true });
    expect((await call("GET", "/api/hub-admin")).body.devices[0].revoked).toBe(true);

    // Blocking signs the person out and removes every computer: after unblocking they pair again.
    expect((await call("POST", "/api/hub-admin/users/ana-dev/disable")).body).toEqual({ ok: true, login: "ana-dev" });
    expect((await call("GET", "/api/hub-admin")).body.users[0].disabled).toBe(true);
    expect((await call("POST", "/api/hub-admin/users/ana-dev/enable")).body.ok).toBe(true);
    expect((await call("POST", "/api/hub-admin/users/ana-dev/delete")).status).toBe(404);
    expect((await call("POST", "/api/hub-admin/users/$(id)/disable")).status).toBe(400);
    expect((await call("POST", "/api/hub-admin/users/nobody/disable")).status).toBe(502);

    const audit = (await call("GET", "/api/hub-admin")).body.audit.map((e: { kind: string }) => e.kind);
    expect(audit).toEqual(expect.arrayContaining(["invite_created", "invite_cancelled", "account_created", "account_disabled", "account_enabled", "device_revoked"]));
  });

  it("is off on every other computer: no page, every route 404", async () => {
    const { db, deps, config } = await setup([], { planned: false });
    const server = buildServer({ app: { ...deps, db, config }, webDir: null });
    expect((await server.inject({ method: "GET", url: "/api/status" })).json().hubAdmin).toBe(false);
    expect((await server.inject({ method: "GET", url: "/api/hub-admin" })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/api/hub-admin/invite", payload: {} })).statusCode).toBe(404);
  });

  it("works from the phone (the page's own routes only)", () => {
    expect(remoteDecision("GET", "/api/hub-admin").kind).toBe("allow");
    for (const p of ["/api/hub-admin/invite", "/api/hub-admin/invites/3/cancel", "/api/hub-admin/devices/3/revoke", "/api/hub-admin/users/ana-dev/disable", "/api/hub-admin/users/ana-dev/enable"]) {
      expect(remoteDecision("POST", p).kind).toBe("allow");
    }
    for (const [m, p] of [["POST", "/api/hub-admin/users/ana-dev/delete"], ["POST", "/api/hub-admin/run"], ["DELETE", "/api/hub-admin/invite"], ["GET", "/api/hub-admin/x"]] as const) {
      expect(remoteDecision(m, p).kind).toBe("deny");
    }
  });
});

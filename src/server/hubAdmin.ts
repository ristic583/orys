/**
 * The owner's Hub page: invite people, block them, remove computers, read the log.
 *
 * The hub has no admin door on the internet. This engine runs the hub's operator command the way
 * `scripts/hub.sh` does, over SSH from this Mac (optionally through a jump host), so only a computer with
 * the owner's SSH key can manage the hub. Only the commands and arguments below are ever sent.
 *
 * Set up only on the owner's Mac, in ~/.config/orys/hub-admin.json:
 *   { "ssh": { "jump": "admin@bastion.example.com", "host": "orys@hub.internal.example" } }
 * or, for a hub on this Mac (development):
 *   { "local": { "db": "/path/to/hub.db", "url": "http://localhost:8787" } }
 * Without the file there is no Hub page and every /api/hub-admin route answers 404.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AIPM_ROOT } from "../config.js";

export const HUB_ADMIN_CONFIG = process.env.ORYS_HUB_ADMIN_CONFIG || join(homedir(), ".config", "orys", "hub-admin.json");

export type HubCommand = ["overview"] | ["invite", string] | ["cancel-invite", number] | ["disable" | "enable", string] | ["revoke-device", number];

export interface HubAdmin {
  /** Where the hub is reached, for the page (no secrets). */
  readonly via: string;
  run(cmd: HubCommand): Promise<unknown>;
}

/** Bad input from the page: answered with 400, nothing is sent to the hub. */
export class HubInputError extends Error {}
/** The hub could not be reached or refused the command. */
export class HubRunError extends Error {}

const SSH_TARGET = /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The note is only a label for the owner: letters, digits and a little punctuation, 60 at most. */
export function cleanNote(note: string): string {
  return note.normalize("NFC").replace(/[^\p{L}\p{N} .,_()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The exact arguments for the hub's operator command; anything unexpected is refused here. */
export function commandArgs(cmd: HubCommand): string[] {
  const [name, arg] = cmd;
  switch (name) {
    case "overview":
      return ["overview"];
    case "invite":
      return ["invite", cleanNote(typeof arg === "string" ? arg : "")];
    case "cancel-invite":
    case "revoke-device":
      if (!Number.isSafeInteger(arg) || (arg as number) <= 0) throw new HubInputError("not an id");
      return [name, String(arg)];
    case "disable":
    case "enable":
      if (typeof arg !== "string" || !GITHUB_LOGIN.test(arg)) throw new HubInputError("not a GitHub login");
      return [name, arg];
    default:
      throw new HubInputError("unknown command");
  }
}

/** POSIX single quotes: ssh hands the remote side one command line, read by its shell. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function sshArgs(ssh: { jump?: string; host: string }, args: string[]): string[] {
  return [
    "-o", "BatchMode=yes", // never wait for a password or a host-key question
    "-o", "ConnectTimeout=8",
    ...(ssh.jump ? ["-J", ssh.jump] : []),
    ssh.host,
    "sudo", "-n", "orys-hub", ...args.map(shq), "--json",
  ];
}

type Exec = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

const execOnce: Exec = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: env ?? process.env }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (typeof e.code === "number") return resolve({ code: e.code, stdout: String(stdout), stderr: String(stderr) });
      resolve({ code: -1, stdout: "", stderr: e.killed ? "no answer within 20 s" : `could not start ${file} (${String(e.code ?? e.message)})` });
    });
  });

function admin(via: string, exec: (args: string[]) => ReturnType<Exec>, ssh: boolean): HubAdmin {
  return {
    via,
    async run(cmd) {
      const args = commandArgs(cmd);
      const r = await exec(args);
      if (r.code !== 0) {
        const why = r.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${r.code}`;
        throw new HubRunError(ssh && r.code === 255 ? `Could not reach the hub over SSH from this Mac: ${why}` : why);
      }
      try {
        return JSON.parse(r.stdout);
      } catch {
        throw new HubRunError("The hub answered with something that is not JSON; is it the same Orys version?");
      }
    },
  };
}

export function sshHubAdmin(ssh: { jump?: string; host: string }, exec: Exec = execOnce): HubAdmin {
  for (const t of [ssh.host, ssh.jump]) if (t !== undefined && !SSH_TARGET.test(t)) throw new Error(`hub-admin: not an SSH target: ${t}`);
  return admin(`ssh ${ssh.jump ? `${ssh.jump} → ` : ""}${ssh.host}`, (args) => exec("ssh", sshArgs(ssh, args)), true);
}

/** A hub on this Mac (development): its operator command, run directly on its database. */
export function localHubAdmin(local: { db: string; url: string }, exec: Exec = execOnce): HubAdmin {
  const script = join(AIPM_ROOT, "src", "hub", "server.ts");
  const env = { ...process.env, ORYS_HUB_DB: local.db, ORYS_HUB_URL: local.url };
  return admin(`local ${local.db}`, (args) => exec(process.execPath, [script, ...args, "--json"], env), false);
}

/** undefined when this computer manages no hub (every invited person's Orys). */
export function loadHubAdmin(path = HUB_ADMIN_CONFIG): HubAdmin | undefined {
  if (!existsSync(path)) return undefined;
  const c = JSON.parse(readFileSync(path, "utf8")) as { ssh?: { jump?: string; host?: string }; local?: { db?: string; url?: string } };
  if (c.ssh && typeof c.ssh.host === "string") return sshHubAdmin({ host: c.ssh.host, ...(typeof c.ssh.jump === "string" ? { jump: c.ssh.jump } : {}) });
  if (c.local && typeof c.local.db === "string" && typeof c.local.url === "string") return localHubAdmin({ db: c.local.db, url: c.local.url });
  throw new Error(`${path}: expected {"ssh": {"host": …}} or {"local": {"db": …, "url": …}}`);
}

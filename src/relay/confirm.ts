/**
 * Asks the owner on the computer itself before a remote request merges into main or creates
 * a project (SPEC §18.3). A stolen hosted login alone cannot do either.
 */
import { execFile } from "node:child_process";

export type Confirm = (question: { title: string; detail: string }) => Promise<boolean>;

/** Nobody clicked within this time: refused. Cloudflare drops a request after 100 s. */
export const CONFIRM_TIMEOUT_SEC = 90;

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/** A macOS dialog with Allow / Deny; "Deny" is the default, silence is a no. Other systems: always no. */
export function macDialogConfirm(opts: { timeoutSec?: number; log?: (line: string) => void } = {}): Confirm {
  const timeout = opts.timeoutSec ?? CONFIRM_TIMEOUT_SEC;
  return ({ title, detail }) =>
    new Promise((resolve) => {
      if (process.platform !== "darwin") {
        opts.log?.(`refused "${detail}": confirming on this computer only works on macOS`);
        return resolve(false);
      }
      const text = `${appleString(detail)} & return & return & ${appleString("This came from the hosted Orys dashboard. Allow it only if you just asked for it.")}`;
      const script = `display dialog (${text}) with title ${appleString(title)} buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" giving up after ${timeout} with icon caution`;
      execFile("osascript", ["-e", script], { timeout: (timeout + 10) * 1000 }, (err, stdout) => {
        // "Deny" is the cancel button, so it ends with an error; so does a closed dialog.
        const allowed = !err && /button returned:Allow/.test(stdout) && !/gave up:true/.test(stdout);
        resolve(allowed);
      });
    });
}

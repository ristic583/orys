/**
 * What the hosted dashboard may do on the owner's computer (SPEC §18.3).
 *
 * The agent checks every request that comes through the relay against this list before it
 * reaches the local engine. Anything not listed is refused, so a new engine route stays
 * local-only until it is added here on purpose. Some actions also need a click on the
 * computer itself (the owner's choice): merging a project into its base branch, creating
 * a project, and deleting one.
 */

export type ConfirmAction = "merge" | "new_project" | "delete_project";
export type RemoteDecision = { kind: "allow" } | { kind: "confirm"; action: ConfirmAction } | { kind: "deny" };

const ID = "[^/]+";
const rx = (pattern: string) => new RegExp(`^${pattern.replaceAll("ID", ID)}$`);

/** Reads the dashboard needs. */
const READ = [
  "/api/(projects|sessions|metrics|status|events|events/stream|usage|runs|repo/discover|remote|hub-admin)",
  "/api/projects/ID",
  "/api/projects/ID/(map|outcome|sketch|phases|decisions|events|deletion)",
  "/api/projects/ID/docs/ID",
  "/api/projects/ID/sketch/files/ID/ID",
  "/api/projects/ID/(designs|screens)/ID",
  "/api/tasks/ID/verifications",
  "/api/runs/ID/log",
].map(rx);

/** Changes allowed from the phone without a confirmation on the computer. */
const WRITE: [method: string, path: RegExp][] = [
  ["POST", rx("/api/projects/ID/(start|choose|outcome/answers|design-choice|handoff/accept|handoff/return|sketch/revise|sketch/approve|approve-plan|unblock|phases|session/reset)")],
  ["PATCH", rx("/api/projects/ID")],
  ["PATCH", rx("/api/tasks/ID")],
  ["DELETE", rx("/api/tasks/ID")],
  ["POST", rx("/api/tasks/ID/(move|retry|skip)")],
  ["POST", rx("/api/phases/ID/tasks")],
  ["PATCH", rx("/api/phases/ID")],
  ["DELETE", rx("/api/phases/ID")],
  ["POST", rx("/api/repo/inspect")],
  ["POST", rx("/api/probe")],
  // Turning remote access off works from anywhere; turning it on only on the computer.
  ["POST", rx("/api/remote/disable")],
  // The owner's Hub page (SPEC §18.5): inviting, blocking, removing computers. Only the
  // owner's Mac has these routes; they never touch this computer's projects.
  ["POST", rx("/api/hub-admin/(invite|invites/ID/cancel|devices/ID/revoke|users/ID/(disable|enable))")],
];

const CONFIRM: [method: string, path: RegExp, action: ConfirmAction][] = [
  ["POST", rx("/api/projects"), "new_project"],
  ["POST", rx("/api/projects/ID/merge-base"), "merge"],
  ["DELETE", rx("/api/projects/ID"), "delete_project"],
];

/** `path` is the URL path as the engine will see it (already normalised, no query). */
export function remoteDecision(method: string, path: string): RemoteDecision {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    // The dashboard itself: static files and client-side routes.
    if (!path.startsWith("/api/")) return { kind: "allow" };
    return READ.some((r) => r.test(path)) ? { kind: "allow" } : { kind: "deny" };
  }
  for (const [cm, cp, action] of CONFIRM) if (cm === m && cp.test(path)) return { kind: "confirm", action };
  return WRITE.some(([wm, wp]) => wm === m && wp.test(path)) ? { kind: "allow" } : { kind: "deny" };
}

/** The project as the owner knows it; the dashboard puts only its id in the URL. */
export type ProjectLabel = { name: string; slug: string };

/** A one-line description of a request that needs the owner's click, for the dialog on the computer. */
export function describeConfirm(action: ConfirmAction, path: string, body?: Buffer, project?: ProjectLabel): string {
  const raw = decodeURIComponent(path.split("/")[3] ?? "?");
  const label = !project ? `“${raw}”` : project.name === project.slug ? `“${project.name}”` : `“${project.name}” (${project.slug})`;
  if (action === "merge") return `Merge project ${label} into its main branch.`;
  if (action === "delete_project") {
    let removeFolder = false;
    try {
      removeFolder = (JSON.parse(body?.toString("utf8") ?? "{}") as { removeFolder?: unknown }).removeFolder === true;
    } catch {
      // treated as keeping the folder
    }
    return `Delete project ${label} from Orys${removeFolder ? ", together with the folder Orys made for it" : ""}.`;
  }
  let brief: { name?: unknown; slug?: unknown; repoPath?: unknown; workspace?: unknown } = {};
  try {
    brief = JSON.parse(body?.toString("utf8") ?? "{}") as typeof brief;
  } catch {
    // shown as an unnamed project
  }
  const name = typeof brief.name === "string" ? brief.name : typeof brief.slug === "string" ? brief.slug : "unnamed";
  const where = typeof brief.repoPath === "string" ? ` in ${brief.repoPath}${brief.workspace === "sandbox" ? " (on a copy)" : ""}` : " in a new folder";
  return `Create project “${name.slice(0, 80)}”${where.slice(0, 200)}.`;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type HubDevice, type HubEvent, type HubInvite, type HubOverview, type HubUser } from "../api";
import { Icon } from "../components/Icon";
import { ErrorText } from "../ui";

/** A computer counts as online if the hub saw it in the last two of its 30-second checks. */
const ONLINE_MS = 75_000;

/** Relative to the hub's own clock, so a skewed Mac clock does not mislead. */
function since(t: number | null, now: number): string {
  if (!t) return "never";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function until(t: number, now: number): string {
  const h = Math.round((t - now) / 3_600_000);
  return h < 48 ? `${Math.max(h, 1)} h` : `${Math.round(h / 24)} days`;
}
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The Orys hub, for its owner (SPEC §18.5): who may come in, their computers, and what happened. */
export function HubPage() {
  const qc = useQueryClient();
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["hub"], queryFn: api.hub, refetchInterval: 30_000, retry: false });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hub"] });

  return (
    <>
      <div className="hero-head">
        <h1>
          Hub{" "}
          {data && (
            <span className="pill pill-soft">
              <i className="dot" />
              {host(data.hubUrl)}
            </span>
          )}
        </h1>
        <button className="ghost" onClick={() => void refetch()} disabled={isFetching} title="Ask the hub again">
          <Icon name="refresh" size={15} /> {isFetching ? "Asking the hub…" : "Refresh"}
        </button>
      </div>

      {error && (
        <section className="card remote-card">
          <p className="remote-line">The hub did not answer.</p>
          <ErrorText error={error} />
          <p className="muted small">This Mac reaches the hub over SSH through the home server, so it works only while the Mac is on the home network or the tailnet.</p>
        </section>
      )}
      {!data && !error && <p className="muted">Asking the hub…</p>}

      {data && (
        <>
          <InviteCard onDone={refresh} />
          <PeopleCard data={data} onDone={refresh} />
          <ComputersCard data={data} onDone={refresh} />
          <InvitesCard data={data} onDone={refresh} />
          <ActivityCard data={data} />
          <p className="muted small">
            Managed from this Mac ({data.via}). The hub itself has no admin page: nobody on the internet can reach these controls.
          </p>
        </>
      )}
    </>
  );
}

function InviteCard({ onDone }: { onDone: () => void }) {
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const create = useMutation({ mutationFn: () => api.hubInvite(note), onSuccess: () => (setNote(""), setCopied(false), onDone()) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  };
  const link = create.data;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // the link stays selectable on the page
    }
  };
  return (
    <section className="card remote-card">
      <h3>
        <Icon name="plus" size={15} /> Invite someone
      </h3>
      <p className="muted small">
        The link works once, for 7 days. Whoever opens it first and signs in with GitHub gets the account, so send it privately (Signal, WhatsApp), not in a group or a public place.
      </p>
      <form className="hub-invite" onSubmit={submit}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who is it for? Only you see this" maxLength={60} aria-label="Who the invite is for" />
        <button className="primary sm" type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create invite link"}
        </button>
      </form>
      <ErrorText error={create.error} />
      {link && (
        <div className="hub-link">
          <code className="mono">{link.url}</code>
          <div className="hub-link-foot">
            <button className="ghost sm" type="button" onClick={() => void copy()}>
              <Icon name={copied ? "check" : "file"} size={14} /> {copied ? "Copied" : "Copy link"}
            </button>
            <span className="muted small">Valid until {new Date(link.expiresAt).toLocaleString()}. Copy it now: the hub keeps only a fingerprint, so this link is not shown again.</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** A button that asks once more, inline, before it acts. */
function ConfirmButton({ label, confirm, danger, busy, onConfirm }: { label: string; confirm: string; danger?: boolean; busy: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button className={`ghost sm${danger ? " danger" : ""}`} onClick={() => setAsking(true)} disabled={busy}>
        {label}
      </button>
    );
  return (
    <span className="hub-confirm">
      <span className="small">{confirm}</span>
      <span className="hub-confirm-btns">
        <button className={`ghost sm${danger ? " danger" : ""}`} onClick={() => (setAsking(false), onConfirm())} disabled={busy}>
          Yes
        </button>
        <button className="ghost sm" onClick={() => setAsking(false)}>
          No
        </button>
      </span>
    </span>
  );
}

function PeopleCard({ data, onDone }: { data: HubOverview; onDone: () => void }) {
  const set = useMutation({ mutationFn: (v: { login: string; disabled: boolean }) => api.hubSetUser(v.login, v.disabled), onSettled: onDone });
  const computers = (u: HubUser) => data.devices.filter((d) => d.userId === u.id && !d.revoked);
  return (
    <section className="card remote-card">
      <h3>
        <Icon name="user" size={15} /> People <span className="muted">{data.users.length}</span>
      </h3>
      {data.users.length === 0 ? (
        <p className="muted small">Nobody yet. Create an invite above.</p>
      ) : (
        <ul className="hub-rows">
          {data.users.map((u) => {
            const own = computers(u);
            const online = own.filter((d) => d.lastSeenAt && data.now - d.lastSeenAt < ONLINE_MS).length;
            return (
              <li key={u.id} className="hub-row">
                <div className="hub-row-main">
                  <b>@{u.login}</b>
                  <span className="muted small">
                    joined {since(u.createdAt, data.now)} ·{" "}
                    {u.disabled ? "signed out, computers removed" : own.length ? `${own.length} computer${own.length > 1 ? "s" : ""}${online ? `, ${online} online` : ""}` : "no computer yet"}
                  </span>
                </div>
                <div className="hub-row-acts">
                  {u.disabled ? (
                    <>
                      <span className="pill tone-red">
                        <i className="dot" />
                        Blocked
                      </span>
                      <ConfirmButton
                        label="Unblock"
                        confirm={`Unblock @${u.login}? They can sign in with GitHub again and pair their computers.`}
                        busy={set.isPending}
                        onConfirm={() => set.mutate({ login: u.login, disabled: false })}
                      />
                    </>
                  ) : (
                    <ConfirmButton
                      label="Block"
                      confirm={`Block @${u.login}? They are signed out and their computers removed; after an unblock they pair them again.`}
                      danger
                      busy={set.isPending}
                      onConfirm={() => set.mutate({ login: u.login, disabled: true })}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={set.error} />
    </section>
  );
}

function ComputersCard({ data, onDone }: { data: HubOverview; onDone: () => void }) {
  const revoke = useMutation({ mutationFn: (id: number) => api.hubRevokeDevice(id), onSettled: onDone });
  const live = data.devices.filter((d) => !d.revoked);
  const removed = data.devices.length - live.length;
  const online = (d: HubDevice) => !!d.lastSeenAt && data.now - d.lastSeenAt < ONLINE_MS;
  return (
    <section className="card remote-card">
      <h3>
        <Icon name="terminal" size={15} /> Computers <span className="muted">{live.length}</span>
      </h3>
      {live.length === 0 ? (
        <p className="muted small">{removed ? "No active computers." : "No computer is connected to the hub yet."}</p>
      ) : (
        <ul className="hub-rows">
          {live.map((d) => (
            <li key={d.id} className="hub-row">
              <div className="hub-row-main">
                <b>{d.name}</b>
                <span className="muted small">
                  @{d.login} · {online(d) ? "online" : `last seen ${since(d.lastSeenAt, data.now)}`}
                  {d.lastIp ? <> · <span className="mono">{d.lastIp}</span></> : null}
                </span>
              </div>
              <div className="hub-row-acts">
                {online(d) && (
                  <span className="pill tone-lime">
                    <i className="dot" />
                    Online
                  </span>
                )}
                <ConfirmButton label="Remove" confirm={`Remove ${d.name}? It disconnects within 30 s and must be paired again.`} danger busy={revoke.isPending} onConfirm={() => revoke.mutate(d.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {removed > 0 && <p className="muted small">{removed} removed computer{removed > 1 ? "s" : ""} not shown.</p>}
      <ErrorText error={revoke.error} />
    </section>
  );
}

function inviteState(i: HubInvite, now: number): { open: boolean; text: string } {
  if (i.usedBy) return { open: false, text: `used by @${i.usedBy} ${since(i.usedAt, now)}` };
  if (i.expiresAt > now) return { open: true, text: `open, ${until(i.expiresAt, now)} left` };
  return { open: false, text: "expired or cancelled" };
}

function InvitesCard({ data, onDone }: { data: HubOverview; onDone: () => void }) {
  const cancel = useMutation({ mutationFn: (id: number) => api.hubCancelInvite(id), onSettled: onDone });
  const [all, setAll] = useState(false);
  if (data.invites.length === 0) return null;
  const rows = data.invites.map((i) => ({ i, s: inviteState(i, data.now) }));
  const shown = all ? rows : rows.filter((r) => r.s.open).concat(rows.filter((r) => !r.s.open).slice(0, 3));
  return (
    <section className="card remote-card">
      <h3>
        <Icon name="file" size={15} /> Invites <span className="muted">{rows.filter((r) => r.s.open).length} open</span>
      </h3>
      <ul className="hub-rows">
        {shown.map(({ i, s }) => (
          <li key={i.id} className="hub-row">
            <div className="hub-row-main">
              <b>{i.note || "No note"}</b>
              <span className="muted small">
                created {since(i.createdAt, data.now)} · {s.text}
              </span>
            </div>
            <div className="hub-row-acts">
              {s.open && <ConfirmButton label="Cancel" confirm="Cancel this invite? The link stops working at once." busy={cancel.isPending} onConfirm={() => cancel.mutate(i.id)} />}
            </div>
          </li>
        ))}
      </ul>
      {!all && shown.length < rows.length && (
        <button className="text-btn" onClick={() => setAll(true)}>
          Show all {rows.length}
        </button>
      )}
      <ErrorText error={cancel.error} />
    </section>
  );
}

const field = (detail: unknown, k: string): string | undefined => {
  const v = detail && typeof detail === "object" ? (detail as Record<string, unknown>)[k] : undefined;
  return v == null ? undefined : String(v);
};

function describe(e: HubEvent, users: Map<number, string>): { text: string; tone?: "red" | "amber" } {
  const who = e.userId != null ? `@${users.get(e.userId) ?? `user ${e.userId}`}` : "";
  const ip = field(e.detail, "ip");
  const from = ip ? ` from ${ip}` : "";
  switch (e.kind) {
    case "invite_created":
      return { text: `Invite created${field(e.detail, "note") ? ` (${field(e.detail, "note")})` : ""}` };
    case "invite_cancelled":
      return { text: "Invite cancelled" };
    case "account_created":
      return { text: `${who} joined` };
    case "login":
      return { text: `${who} signed in${from}` };
    case "login_refused_no_invite":
      return { text: `GitHub @${field(e.detail, "github") ?? "?"} tried to sign in without an invite${from}`, tone: "amber" };
    case "login_refused_disabled":
      return { text: `${who} tried to sign in while blocked${from}`, tone: "red" };
    case "account_disabled":
      return { text: `${who} blocked` };
    case "account_enabled":
      return { text: `${who} unblocked` };
    case "pairing_approved":
      return { text: `${who} confirmed the pairing code for ${field(e.detail, "name") ?? "a computer"}${from}` };
    case "device_paired":
      return { text: `${field(e.detail, "name") ?? "A computer"} joined ${who}'s account` };
    case "device_revoked":
      return { text: `${who}: computer #${field(e.detail, "device") ?? "?"} removed${field(e.detail, "by") === "operator" ? " by you" : ""}` };
    case "sessions_revoked":
      return { text: `${who} signed out everywhere else` };
    case "orys_downloaded":
      return { text: `${who} downloaded Orys` };
    default:
      return { text: `${who} ${e.kind.replaceAll("_", " ")}`.trim() };
  }
}

function ActivityCard({ data }: { data: HubOverview }) {
  const users = new Map(data.users.map((u) => [u.id, u.login]));
  if (data.audit.length === 0) return null;
  return (
    <section className="card remote-card">
      <h3>
        <Icon name="list" size={15} /> Activity
      </h3>
      <ul className="hub-log">
        {data.audit.map((e, n) => {
          const d = describe(e, users);
          return (
            <li key={`${e.at}-${n}`} className={d.tone ? `tone-${d.tone}` : undefined}>
              <span className="muted small hub-log-time" title={new Date(e.at).toLocaleString()}>
                {since(e.at, data.now)}
              </span>
              <span className="small">{d.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

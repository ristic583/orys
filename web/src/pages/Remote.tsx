import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago, api, type RemoteView } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../router";
import { ErrorText } from "../ui";

type On = Extract<RemoteView, { available: true }>;

const TONE: Record<On["state"], string> = { connected: "lime", connecting: "amber", off: "muted", not_configured: "muted" };
const LABEL: Record<On["state"], string> = { connected: "Connected", connecting: "Connecting", off: "Off", not_configured: "Not set up" };

/** Remote access (SPEC §18): whether the hosted dashboard reaches this computer, and the switch for it. */
export function RemotePage() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["remote"], queryFn: api.remote, refetchInterval: 5_000 });
  const toggle = useMutation({ mutationFn: (on: boolean) => api.setRemote(on), onSettled: () => void qc.invalidateQueries({ queryKey: ["remote"] }) });
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.available) return <p className="muted">Remote access works only when Orys runs with <code>orys serve</code>.</p>;
  const remoteHere = data.via === "remote";
  const since = data.since ? ago(new Date(data.since).toISOString()) : null;

  return (
    <>
      <div className="hero-head">
        <h1>
          Remote access{" "}
          <span className={`pill pill-soft tone-${TONE[data.state]}`}>
            <i className="dot" />
            {LABEL[data.state]}
          </span>
        </h1>
      </div>

      <section className="card remote-card">
        <p className="remote-line">
          {data.state === "connected" && <>The hosted dashboard at <b>{data.relayHost}</b> reaches this computer{since ? `, connected ${since}` : ""}.</>}
          {data.state === "connecting" && <>Trying to reach <b>{data.relayHost}</b>{since ? ` since ${since}` : ""}. Orys keeps trying on its own.</>}
          {data.state === "off" && (data.enabled ? <>Not connected: this Orys was started without <code>--agent</code>. Turn it on here, or let the background service run Orys.</> : <>Turned off. The hosted dashboard shows “computer offline” until you turn it on here.</>)}
          {data.state === "not_configured" && <>Not set up on this computer yet; see the steps below.</>}
        </p>
        {data.lastError && <p className="error small">{data.lastError}</p>}
        {data.hub && remoteHere && (
          <p className="muted small">
            Connected through an Orys hub. <a href="/_hub/devices">Your computers</a> lists them, and you can switch or remove one there.
          </p>
        )}
        {data.configured && (
          <div className="remote-actions">
            {data.state === "connected" || data.state === "connecting" ? (
              <button className="ghost" onClick={() => toggle.mutate(false)} disabled={toggle.isPending}>
                <Icon name="pause" size={15} /> Turn off remote access
              </button>
            ) : (
              <button className="primary" onClick={() => toggle.mutate(true)} disabled={toggle.isPending || remoteHere}>
                <Icon name="play" size={15} /> Turn on remote access
              </button>
            )}
            {remoteHere && <span className="muted small">You are on the hosted dashboard: turning it off disconnects this page, and only the computer can turn it back on.</span>}
          </div>
        )}
        <ErrorText error={toggle.error} />
      </section>

      <section className="card remote-card">
        <h3><Icon name="shield" size={15} /> What the hosted dashboard may do</h3>
        <ul className="remote-list">
          <li>Everything you do day to day: approve sketches and plans, answer questions, pause, retry, accept or send back a result.</li>
          <li><b>Merging into main</b>, <b>creating a project</b> and <b>deleting one</b> wait for a click on this computer. Nobody clicks within 90 seconds: refused.</li>
          <li>Turning remote access on, and anything not on this list, works only here on the computer.</li>
        </ul>
      </section>

      {(!data.configured || (!data.serviceToken && !data.hub)) && (
        <section className="card remote-card">
          <h3><Icon name="terminal" size={15} /> Set up</h3>
          <ol className="remote-list">
            {!data.configured && <li>Relay address and agent token: <code>pnpm orys agent --save --relay wss://orys.example.com/_relay/agent --token …</code></li>}
            {!data.configured && <li>Or, with an invite to an Orys hub: <code>pnpm orys agent login --hub https://…</code></li>}
            {data.configured && !data.serviceToken && !data.hub && <li>Cloudflare Access service token for this computer: <code>pnpm orys agent --save --access-client-id … --access-client-secret …</code></li>}
            <li>Keep Orys running in the background: <code>bash scripts/launchd.sh install</code></li>
          </ol>
        </section>
      )}
    </>
  );
}

/** Top bar: remote access at a glance; opens the page above. */
export function RemoteChip({ data }: { data: RemoteView | undefined }) {
  if (!data?.available) return null;
  const tone = TONE[data.state];
  return (
    <Link to="/remote" className={`chip${tone === "muted" ? " muted" : ` tone-${tone}`}`} title={`Remote access: ${LABEL[data.state].toLowerCase()}${data.relayHost ? ` (${data.relayHost})` : ""}`}>
      <i className="dot" />
      Remote
    </Link>
  );
}

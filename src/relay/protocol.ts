/**
 * Frames between the relay (server) and the agent (user's computer), SPEC §18.2.
 * Bodies and response chunks travel as base64 so binary assets survive JSON.
 * Type-only module: the relay runs under Node's type stripping, so it may only
 * `import type` from here.
 */

/** relay → agent */
export type RelayToAgent =
  | { t: "req"; id: number; method: string; url: string; headers: Record<string, string>; body?: string }
  | { t: "cancel"; id: number };

/** agent → relay */
export type AgentToRelay =
  | { t: "hello"; agent: string; version: number }
  | { t: "head"; id: number; status: number; headers: Record<string, string> }
  | { t: "chunk"; id: number; data: string }
  | { t: "end"; id: number }
  | { t: "error"; id: number; message: string };

export const PROTOCOL_VERSION = 1;

/** Request headers the relay passes on to the local engine. Everything else (cookies, auth) stays at the relay. */
export const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
  "last-event-id",
  "user-agent",
];

/**
 * Set by the agent on every request it forwards, so the engine knows the request came from
 * the hosted dashboard. The relay cannot set it: only FORWARDED_REQUEST_HEADERS pass.
 */
export const REMOTE_MARKER_HEADER = "x-orys-remote";

/** Hop-by-hop or rewritten response headers that must not be copied back to the browser. */
export const DROPPED_RESPONSE_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding", "set-cookie"];

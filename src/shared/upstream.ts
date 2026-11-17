/**
 * The `Upstream` seam between the HTTP endpoint (server side) and whatever actually
 * talks to a real MCP server (T1: a local stdio client; T2: the WebSocket tunnel).
 *
 * The endpoint never knows how the upstream is reached. It only needs to know
 * *what the upstream server is* (cached `initialize` result), and to be able to
 * push requests/notifications at it.
 *
 * Error contract (see `src/shared/errors.ts`):
 * - `request()` rejects with an `McpError` carrying the **upstream** JSON-RPC code
 *   when the upstream server answered with an error. Those pass through unchanged.
 * - `request()` rejects with a {@link ProxyError} (code `-32050`,
 *   `data: {source: "mcp-websocket-proxy", reason}`) when the proxy itself cannot
 *   serve the request (`offline`, `server_down`, `client_disconnected`, `timeout`,
 *   `too_large`).
 */

import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

/**
 * The cached `initialize` result of the upstream server, captured once when the
 * upstream session is established and refreshed on every (re)connect.
 *
 * The endpoint answers Warren's `initialize` entirely from this object, so Warren
 * can talk to the endpoint even while no upstream round-trip is happening.
 */
export interface UpstreamInfo {
  /** Protocol version negotiated with the upstream server. */
  protocolVersion: string;
  /** Capabilities advertised by the upstream server (relayed verbatim). */
  capabilities: ServerCapabilities;
  /** `serverInfo` advertised by the upstream server. */
  serverInfo: Implementation;
  /** Optional `instructions` advertised by the upstream server. */
  instructions?: string | undefined;
}

/** `notifications/progress` payload, without the progress token. */
export interface UpstreamProgress {
  progress: number;
  total?: number | undefined;
  message?: string | undefined;
  [key: string]: unknown;
}

export interface UpstreamRequestOptions {
  /**
   * Aborts the request. The caller (the endpoint) passes the SDK's per-request
   * signal, so a Warren-side `notifications/cancelled` propagates to the upstream.
   */
  signal?: AbortSignal | undefined;
  /**
   * Receives `notifications/progress` notifications the upstream emits *for this
   * request*. Progress tokens are owned by the implementation: the caller must not
   * leak its own progress token into `params`.
   */
  onProgress?: ((progress: UpstreamProgress) => void) | undefined;
  /** Per-request deadline in ms. Implementations should fail with `timeout`. */
  timeoutMs?: number | undefined;
  /**
   * The Warren session (`Mcp-Session-Id`) this request belongs to, when the caller
   * has one. Purely for attribution/logging (e.g. the T2 tunnel tags tunnel frames so
   * logs on the work PC can be traced back to a session); implementations must not
   * base protocol behaviour on it.
   */
  sessionId?: string | undefined;
}

/** A notification that originated at the upstream server. */
export interface UpstreamNotification {
  method: string;
  params?: unknown;
}

export type UpstreamNotificationListener = (notification: UpstreamNotification) => void;

/**
 * A live, already-initialised MCP server that the endpoint can drive.
 *
 * Implementations: {@link LocalMcpServer} (T1, stdio child process) and, in T2, a
 * tunnel-backed upstream that serialises `{method, params}` onto the WebSocket.
 */
export interface Upstream {
  /** Stable identifier of the proxied server (matches `^[a-z0-9][a-z0-9_-]{0,62}$`). */
  readonly name: string;

  /**
   * Cached `initialize` result. Must throw a {@link ProxyError} with reason
   * `server_down`/`offline` when no upstream session has ever been established.
   */
  readonly info: UpstreamInfo;

  /** False when the upstream is known to be unable to serve requests right now. */
  readonly available: boolean;

  /**
   * Sends a JSON-RPC request and resolves with the raw `result` object.
   * Rejects per the error contract above.
   */
  request(method: string, params?: unknown, options?: UpstreamRequestOptions): Promise<unknown>;

  /** Sends a JSON-RPC notification (no response expected). */
  notification(method: string, params?: unknown): Promise<void>;

  /**
   * Subscribes to notifications originated by the upstream server
   * (e.g. `notifications/tools/list_changed`, `notifications/message`).
   * Returns an unsubscribe function. Progress notifications belonging to a
   * `request()` made through this interface are delivered to that request's
   * `onProgress` instead and are *not* replayed here.
   */
  subscribe(listener: UpstreamNotificationListener): () => void;
}

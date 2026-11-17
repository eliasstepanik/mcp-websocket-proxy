/**
 * Shared error helpers for the proxy.
 *
 * Two classes of errors exist on the wire:
 *
 * - **Upstream errors**: produced by a real MCP server behind the tunnel. They are
 *   relayed to Warren *unchanged* (same JSON-RPC code, message and data).
 * - **Proxy errors**: produced by this project itself (the work PC is offline, the
 *   tunnel is down, a request timed out, ...). They always use JSON-RPC code
 *   {@link PROXY_ERROR_CODE} and carry `data: { source: "mcp-websocket-proxy", reason }`
 *   so Warren can tell proxy failures from server failures.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';

/** JSON-RPC error code used for every proxy-originated error. */
export const PROXY_ERROR_CODE = -32050;

/** Value of `data.source` on every proxy-originated error. */
export const PROXY_ERROR_SOURCE = 'mcp-websocket-proxy';

/**
 * Why the proxy (and not an upstream server) failed a request.
 *
 * - `offline`            no live tunnel for the requested server right now
 * - `server_down`        the tunnel is up but the local stdio server is not running
 * - `client_disconnected` the tunnel dropped while the request was in flight
 * - `timeout`            the request exceeded its deadline
 * - `too_large`          a message exceeded the negotiated size limit
 */
export const PROXY_ERROR_REASONS = ['offline', 'server_down', 'client_disconnected', 'timeout', 'too_large'] as const;

export type ProxyErrorReason = (typeof PROXY_ERROR_REASONS)[number];

export interface ProxyErrorData {
  source: typeof PROXY_ERROR_SOURCE;
  reason: ProxyErrorReason;
  [key: string]: unknown;
}

/**
 * A proxy-originated JSON-RPC error.
 *
 * Extends the SDK's `McpError` so the SDK's server-side error path forwards
 * `code`/`message`/`data` verbatim onto the wire.
 */
export class ProxyError extends McpError {
  readonly reason: ProxyErrorReason;

  constructor(reason: ProxyErrorReason, message: string, data?: Record<string, unknown>) {
    super(PROXY_ERROR_CODE, message, { source: PROXY_ERROR_SOURCE, reason, ...data });
    this.name = 'ProxyError';
    this.reason = reason;
  }
}

/** Build a {@link ProxyError}. Throw it from any `Upstream` implementation. */
export function proxyError(reason: ProxyErrorReason, message: string, data?: Record<string, unknown>): ProxyError {
  return new ProxyError(reason, message, data);
}

/** True when `error` is a proxy-originated error (as opposed to an upstream one). */
export function isProxyError(error: unknown): error is ProxyError {
  if (error instanceof ProxyError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; data?: unknown };
  return (
    candidate.code === PROXY_ERROR_CODE &&
    typeof candidate.data === 'object' &&
    candidate.data !== null &&
    (candidate.data as { source?: unknown }).source === PROXY_ERROR_SOURCE
  );
}

/**
 * Normalise an unknown thrown value into something the SDK will serialise as a
 * JSON-RPC error, without touching upstream codes.
 */
export function toRelayableError(error: unknown): Error {
  if (error instanceof McpError) return error;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      const data = (error as { data?: unknown }).data;
      return new McpError(code, error.message, data);
    }
    return error;
  }
  return new McpError(-32603, String(error));
}

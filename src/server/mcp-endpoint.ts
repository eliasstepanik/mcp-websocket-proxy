/**
 * The Streamable HTTP MCP endpoint (`/mcp/<name>` on the real server).
 *
 * One {@link McpEndpointSession} == one Warren session == one SDK `Server` + one
 * `StreamableHTTPServerTransport`. Never a singleton: the transport owns the HTTP
 * response and the per-session state.
 *
 * Responsibilities:
 * - `initialize` and `ping` are answered locally, from the cached
 *   {@link UpstreamInfo}, so Warren can initialise without an upstream round-trip.
 * - every other request is relayed through {@link Upstream.request}; upstream
 *   errors keep their JSON-RPC code, proxy errors use `-32050`.
 * - upstream-originated notifications are forwarded to Warren over the session's
 *   standalone SSE stream; per-request progress is re-tagged with Warren's own
 *   progress token.
 *
 * HTTP note: `transport.handleRequest()` writes the response itself (status line,
 * headers and SSE frames). Never write to `res` yourself for a request you hand to
 * the transport, or it will throw on the already-headers-sent response.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type JSONRPCRequest, type Result } from '@modelcontextprotocol/sdk/types.js';

import type { Upstream, UpstreamNotification, UpstreamProgress } from '../shared/upstream.js';
import {
  PROXY_ERROR_CODE,
  PROXY_ERROR_REASONS,
  PROXY_ERROR_SOURCE,
  isProxyError,
  proxyError,
  type ProxyErrorReason,
} from '../shared/errors.js';

/** Max bytes accepted for a single JSON-RPC POST body. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * `Retry-After` (seconds) sent with the 503 that answers `initialize` while nothing
 * is upstream: the tunnel may come back at any time, so keep the hint short.
 */
const OFFLINE_RETRY_AFTER_SECONDS = 10;

/** Default idle TTL: a Warren session that has not been used for a week is reaped. */
const DEFAULT_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid MCP server names (no dots: Warren splits `mcp.<server>.<tool>` on the first dot). */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function assertValidServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid server name ${JSON.stringify(name)}: must match ${SERVER_NAME_PATTERN}`);
  }
}

export interface McpEndpointSessionOptions {
  /** Called with the session id as soon as the transport has created it. */
  onSessionInitialized?: (sessionId: string) => void;
  /** Called when the session is gone (DELETE, transport close, or {@link McpEndpointSession.close}). */
  onClosed?: () => void;
}

export interface McpEndpointSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  readonly sessionId: string | undefined;
  close(): Promise<void>;
}

/**
 * Creates one Warren session: a fresh `Server` whose advertised capabilities mirror
 * the upstream's, plus a fresh Streamable HTTP transport wired to it.
 */
export async function createEndpointSession(upstream: Upstream, options: McpEndpointSessionOptions = {}): Promise<McpEndpointSession> {
  const info = upstream.info;

  // `instructions` belongs to the *options*, not to `serverInfo`: the SDK copies
  // `options.instructions` into the top-level `instructions` field of the
  // `initialize` result, while anything put in the first argument is relayed inside
  // `serverInfo` (where Warren's client never looks for it).
  const server = new Server(
    { name: info.serverInfo.name, version: info.serverInfo.version },
    {
      capabilities: info.capabilities,
      ...(info.instructions !== undefined ? { instructions: info.instructions } : {}),
    },
  );

  // The SDK's `Server` answers `logging/setLevel` itself when the `logging`
  // capability is advertised. We are a proxy: the upstream owns that state, so drop
  // the built-in handler and let the fallback relay it.
  server.removeRequestHandler('logging/setLevel');

  server.fallbackRequestHandler = async (request: JSONRPCRequest, extra) => {
    const params = stripProgressToken(request.params);
    const warrenToken = readProgressToken(request.params);

    try {
      return await upstream.request(request.method, params, {
        ...(extra.signal ? { signal: extra.signal } : {}),
        ...(transport.sessionId !== undefined ? { sessionId: transport.sessionId } : {}),
        ...(warrenToken !== undefined
          ? {
              onProgress: (progress: UpstreamProgress) => {
                void server
                  .notification(
                    {
                      method: 'notifications/progress',
                      params: { progressToken: warrenToken, ...progress },
                    },
                    { relatedRequestId: extra.requestId },
                  )
                  .catch(() => {
                    /* Warren's stream is gone; progress is best-effort. */
                  });
              },
            }
          : {}),
      }) as Promise<Result>;
    } catch (error) {
      throw toWireError(error);
    }
  };

  server.fallbackNotificationHandler = async (notification) => {
    await upstream.notification(notification.method, notification.params);
  };

  let closed = false;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    ...(options.onSessionInitialized ? { onsessioninitialized: options.onSessionInitialized } : {}),
    ...(options.onClosed ? { onsessionclosed: () => options.onClosed?.() } : {}),
  });

  const unsubscribe = upstream.subscribe((notification: UpstreamNotification) => {
    // JSON-RPC `params` is optional, never null: the upstream may legitimately have
    // sent `params: null`, which the SDK's schemas reject. Normalise it away.
    const params = (notification.params ?? undefined) as Record<string, unknown> | undefined;
    void server
      .notification({
        method: notification.method,
        ...(params !== undefined ? { params } : {}),
      })
      .catch(() => {
        /* No live SSE stream for this session right now: notification dropped. */
      });
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unsubscribe();
    options.onClosed?.();
    await transport.close();
    await server.close();
  };
  transport.onclose = () => {
    void close();
  };

  await server.connect(transport);

  return {
    server,
    transport,
    get sessionId() {
      return transport.sessionId;
    },
    close,
  };
}

export interface McpEndpointHandlerOptions {
  /** Name of the proxied server (validated against {@link SERVER_NAME_PATTERN}). */
  name: string;
  /**
   * Resolves the upstream to bind to a new Warren session. Throw a {@link ProxyError}
   * (e.g. reason `offline`) to fail `initialize` with a proxy error instead.
   */
  upstream: Upstream | (() => Upstream);
  /** Observes session creation (T2 uses this to bind tunnel state). */
  onSession?: (session: McpEndpointSession) => void;
  /**
   * Idle TTL in ms: a session that has not served a request for this long is closed
   * and forgotten, so its id answers 404 like any unknown session.
   * Default one week; inject a short value in tests.
   */
  sessionIdleTtlMs?: number;
}

export interface McpEndpointHandler {
  /** Handles GET/POST/DELETE for one `/mcp/<name>` route. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of live Warren sessions. */
  sessionCount(): number;
  /**
   * Pushes one notification to every live Warren session on this route. Used for
   * notifications the proxy itself has to synthesise (e.g. a `list_changed` after a
   * server went down and came back, which the upstream could not emit for the gap).
   * Sessions without a live SSE stream drop it, exactly like upstream notifications.
   */
  notifyAll(method: string, params?: unknown): void;
  close(): Promise<void>;
}

/** A live session plus the bookkeeping the idle reaper needs. */
interface SessionEntry {
  session: McpEndpointSession;
  /** `Date.now()` of the last request this session served. */
  lastSeen: number;
}

/**
 * Builds the request handler for one `/mcp/<name>` route. Warren sessions are keyed
 * by the `Mcp-Session-Id` the transport generates during `initialize`.
 */
export function createMcpEndpointHandler(options: McpEndpointHandlerOptions): McpEndpointHandler {
  assertValidServerName(options.name);
  const sessions = new Map<string, SessionEntry>();
  const resolveUpstream = typeof options.upstream === 'function' ? (options.upstream as () => Upstream) : () => options.upstream as Upstream;
  const idleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;

  // Periodic reaper: forget (and close) sessions nobody has used for `idleTtlMs`.
  // The interval is shortened for small TTLs so tests do not have to wait a minute.
  const reap = (): void => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen >= idleTtlMs) {
        sessions.delete(id);
        void entry.session.close().catch(() => undefined);
      }
    }
  };
  const reaper = setInterval(reap, Math.max(50, Math.min(60_000, idleTtlMs / 2)));
  reaper.unref?.();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headerSessionId = firstHeader(req, 'mcp-session-id');
    // A session built by *this* request: if it never gets a session id (rejected
    // initialize, or a throw below) it is unreachable and must not leak.
    let newSession: McpEndpointSession | undefined;

    try {
      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (proxyReasonOf(error) === 'too_large') {
            sendJson(res, 413, proxyJsonRpcError(null, 'too_large', (error as Error).message));
            return;
          }
          sendJson(res, 400, jsonRpcError(null, -32700, (error as Error).message));
          return;
        }

        let entry = headerSessionId ? sessions.get(headerSessionId) : undefined;
        if (entry) entry.lastSeen = Date.now();
        let session = entry?.session;

        if (!session) {
          if (!isInitializeRequest(body)) {
            // A session id we do not know means the session is gone: 404 tells the client
            // to re-initialize (spec). A *missing* header is simply a bad request.
            if (headerSessionId) {
              sendJson(res, 404, jsonRpcError(null, -32000, 'Not Found: unknown Mcp-Session-Id'));
            } else {
              sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: missing Mcp-Session-Id'));
            }
            return;
          }
          let upstream: Upstream;
          try {
            upstream = resolveUpstream();
            void upstream.info; // fails fast with a proxy error when nothing is upstream
          } catch (error) {
            const reason = proxyReasonOf(error);
            if (reason !== undefined && isRetryableOffline(reason)) {
              sendJson(
                res,
                503,
                proxyJsonRpcError(null, reason, (error as Error).message),
                { 'retry-after': String(OFFLINE_RETRY_AFTER_SECONDS) },
              );
              return;
            }
            const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -32603;
            sendJson(res, 500, jsonRpcError(null, code, (error as Error).message));
            return;
          }
          const created = await createEndpointSession(upstream, {
            onSessionInitialized: (sessionId) => sessions.set(sessionId, { session: created, lastSeen: Date.now() }),
            onClosed: () => {
              if (created.sessionId) sessions.delete(created.sessionId);
            },
          });
          session = created;
          newSession = created;
          options.onSession?.(created);
        }

        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const entry = headerSessionId ? sessions.get(headerSessionId) : undefined;
        const session = entry?.session;
        if (!session) {
          if (headerSessionId) {
            sendJson(res, 404, jsonRpcError(null, -32000, 'Not Found: unknown Mcp-Session-Id'));
          } else {
            sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: missing Mcp-Session-Id'));
          }
          return;
        }
        entry!.lastSeen = Date.now();
        if (req.method === 'DELETE') {
          sessions.delete(session.sessionId ?? headerSessionId ?? '');
          await session.transport.handleRequest(req, res);
          await session.close();
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, jsonRpcError(null, -32000, 'Method Not Allowed'));
    } catch (error) {
      // Callers do `void handler.handle(...)` (and the SDK transport may reject
      // mid-stream): never let a throw escape into an unhandled rejection.
      // `sendJson` no-ops to `res.end()` when the transport already sent headers.
      const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : -32603;
      sendJson(res, 500, jsonRpcError(null, code, error instanceof Error ? error.message : String(error)));
    } finally {
      // A session that never produced a session id (rejected initialize, e.g. 406 for
      // a bad Accept header, or a throw above) is unreachable: drop it again.
      if (newSession && !newSession.sessionId) {
        await newSession.close().catch(() => undefined);
      }
    }
  };

  return {
    handle,
    sessionCount: () => sessions.size,
    notifyAll: (method, params) => {
      // Same normalisation as the upstream-notification path: `params` is optional,
      // never null.
      const normalised = (params ?? undefined) as Record<string, unknown> | undefined;
      for (const entry of sessions.values()) {
        void entry.session.server
          .notification({ method, ...(normalised !== undefined ? { params: normalised } : {}) })
          .catch(() => {
            /* No live SSE stream for this session right now: notification dropped. */
          });
      }
    },
    close: async () => {
      clearInterval(reaper);
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((entry) => entry.session.close()));
    },
  };
}

/**
 * Rebuild an error thrown by the upstream leg so the SDK serialises it verbatim.
 *
 * The SDK's `McpError` prefixes `message` with `MCP error <code>: `, and that prefix
 * accumulates once per hop (fixture -> local client -> this endpoint -> Warren).
 * The SDK's own error path only reads `code`/`message`/`data`, so we hand it a plain
 * error carrying the *unprefixed* message.
 */
function toWireError(error: unknown): Error {
  const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : -32603;
  const raw = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(stripMcpErrorPrefixes(raw)), {
    code,
    ...((error as { data?: unknown })?.data !== undefined ? { data: (error as { data?: unknown }).data } : {}),
  });
}

/**
 * Strip every repeated `MCP error -1234: ` prefix from a message.
 *
 * NOTE: this is only a heuristic for the T1 stdio hop (the SDK's `McpError` prefixes
 * `message` once per hop, and the prefix accumulates across fixture -> client ->
 * endpoint). T2's WebSocket tunnel must instead carry the raw `{code, message, data}`
 * triple across the wire so no prefix is ever added, rather than relying on this
 * message-stripping to undo it.
 */
function stripMcpErrorPrefixes(message: string): string {
  let out = message;
  for (;;) {
    const stripped = out.replace(/^MCP error -?\d+: /, '');
    if (stripped === out) return out;
    out = stripped;
  }
}

function readProgressToken(params: unknown): string | number | undefined {  const meta = isRecord(params) ? params._meta : undefined;
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

/** Remove Warren's progress token: the upstream leg owns its own tokens. */
function stripProgressToken(params: unknown): unknown {
  if (!isRecord(params)) return params;
  const meta = isRecord(params._meta) ? { ...params._meta } : undefined;
  if (meta && 'progressToken' in meta) {
    delete meta.progressToken;
    return { ...params, _meta: meta };
  }
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Oversized bodies are a proxy-level failure, not a JSON-RPC parse error.
    if (size > MAX_BODY_BYTES) throw proxyError('too_large', `Request body too large (limit ${MAX_BODY_BYTES} bytes)`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new Error('Empty request body');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Parse error: Invalid JSON');
  }
}

function jsonRpcError(id: unknown, code: number, message: string): unknown {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

/**
 * A proxy-originated error on the wire: JSON-RPC code {@link PROXY_ERROR_CODE} with
 * `data: { source, reason }` so Warren can tell proxy failures from upstream ones.
 * The proxy's own metadata never goes inside `error` itself (that would overwrite the
 * JSON-RPC `code`).
 */
function proxyJsonRpcError(id: unknown, reason: ProxyErrorReason, message: string): unknown {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: PROXY_ERROR_CODE,
      message,
      data: { source: PROXY_ERROR_SOURCE, reason },
    },
  };
}

/** The reason a thrown error carries, when it is a proxy error. */
function proxyReasonOf(error: unknown): ProxyErrorReason | undefined {
  if (!isProxyError(error)) return undefined;
  const candidate = error as { reason?: unknown; data?: { reason?: unknown } };
  const reason = candidate.reason ?? candidate.data?.reason;
  return (PROXY_ERROR_REASONS as readonly string[]).includes(String(reason)) ? (reason as ProxyErrorReason) : 'timeout';
}

/** Reasons that mean "try again later": they answer `initialize` with a 503. */
function isRetryableOffline(reason: ProxyErrorReason): boolean {
  return reason === 'offline' || reason === 'server_down';
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

export { proxyError };

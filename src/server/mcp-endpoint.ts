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
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE, proxyError } from '../shared/errors.js';

/** Max bytes accepted for a single JSON-RPC POST body. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

  const server = new Server(
    {
      name: info.serverInfo.name,
      version: info.serverInfo.version,
      ...(info.instructions !== undefined ? { instructions: info.instructions } : {}),
    },
    { capabilities: info.capabilities },
  );

  // The SDK's `Server` answers `logging/setLevel` itself when the `logging`
  // capability is advertised. We are a proxy: the upstream owns that state, so drop
  // the built-in handler and let the fallback relay it.
  server.removeRequestHandler('logging/setLevel');

  server.fallbackRequestHandler = async (request: JSONRPCRequest, extra) => {
    const params = stripProgressToken(request.params);
    const warrenToken = readProgressToken(request.params);

    return upstream.request(request.method, params, {
      ...(extra.signal ? { signal: extra.signal } : {}),
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
    void server
      .notification({
        method: notification.method,
        ...(notification.params !== undefined ? { params: notification.params } : {}),
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
}

export interface McpEndpointHandler {
  /** Handles GET/POST/DELETE for one `/mcp/<name>` route. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of live Warren sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

/**
 * Builds the request handler for one `/mcp/<name>` route. Warren sessions are keyed
 * by the `Mcp-Session-Id` the transport generates during `initialize`.
 */
export function createMcpEndpointHandler(options: McpEndpointHandlerOptions): McpEndpointHandler {
  assertValidServerName(options.name);
  const sessions = new Map<string, McpEndpointSession>();
  const resolveUpstream = typeof options.upstream === 'function' ? (options.upstream as () => Upstream) : () => options.upstream as Upstream;

  const bindSession = (session: McpEndpointSession): void => {
    if (session.sessionId) sessions.set(session.sessionId, session);
    options.onSession?.(session);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headerSessionId = firstHeader(req, 'mcp-session-id');

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, jsonRpcError(null, -32700, (error as Error).message));
        return;
      }

      let session = headerSessionId ? sessions.get(headerSessionId) : undefined;

      if (!session) {
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: unknown or missing Mcp-Session-Id'));
          return;
        }
        let upstream: Upstream;
        try {
          upstream = resolveUpstream();
          void upstream.info; // fails fast with a proxy error when nothing is upstream
        } catch (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -32603;
          sendJson(res, 503, jsonRpcError(null, code, (error as Error).message, (error as { data?: unknown }).data));
          return;
        }
        const created = await createEndpointSession(upstream, {
          onSessionInitialized: (sessionId) => sessions.set(sessionId, created),
          onClosed: () => {
            if (session?.sessionId) sessions.delete(session.sessionId);
          },
        });
        session = created;
        bindSession(created);
        pendingNewSession = created;
      }

      await session.transport.handleRequest(req, res, body);
      // A failed initialize (e.g. 406 on a bad Accept header) never produced a
      // session id, so the session we just built is unreachable: drop it.
      if (pendingNewSession && !pendingNewSession.sessionId) {
        await pendingNewSession.close();
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = headerSessionId ? sessions.get(headerSessionId) : undefined;
      if (!session) {
        sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: unknown or missing Mcp-Session-Id'));
        return;
      }
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
  };

  return {
    handle,
    sessionCount: () => sessions.size,
    close: async () => {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.close()));
    },
  };
}

function readProgressToken(params: unknown): string | number | undefined {
  const meta = isRecord(params) ? params._meta : undefined;
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
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
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

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : { source: PROXY_ERROR_SOURCE, code: PROXY_ERROR_CODE }) },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export { proxyError };

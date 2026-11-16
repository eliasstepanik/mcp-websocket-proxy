/**
 * The Streamable HTTP MCP endpoint (`/mcp/<name>` on the real server).
 *
 * One {@link McpEndpointSession} = one Warren session = one SDK `Server` + one
 * `StreamableHTTPServerTransport`. Never a singleton: the transport owns the HTTP
 * response and the per-session state.
 *
 * Responsibilities:
 * - `initialize` and `ping` are answered locally from the cached
 *   {@link UpstreamInfo}, so Warren can initialise even when the upstream is a
 *   cached snapshot.
 * - every other request is relayed through {@link Upstream.request}; upstream
 *   errors keep their JSON-RPC code, proxy errors use `-32050`.
 * - upstream-originated notifications are forwarded to Warren over the session's
 *   standalone SSE stream; per-request progress is re-tagged with Warren's own
 *   progress token.
 *
 * Note on HTTP: `transport.handleRequest()` writes the response itself (including
 * headers and SSE frames). Never touch `res` yourself or the transport will throw.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type JSONRPCRequest, type Result } from '@modelcontextprotocol/sdk/types.js';

import type { Upstream, UpstreamNotification } from '../shared/upstream.js';
import { proxyError } from '../shared/errors.js';

/** Max bytes accepted for a single JSON-RPC POST body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Valid MCP server names (no dots: Warren splits `mcp.<server>.<tool>` on the first dot). */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function assertValidServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid server name ${JSON.stringify(name)}: must match ${SERVER_NAME_PATTERN}`);
  }
}

export interface McpEndpointSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  sessionId: string | undefined;
  close(): Promise<void>;
}

/**
 * Creates one Warren session: a fresh `Server` whose capabilities mirror the
 * upstream's, plus a fresh Streamable HTTP transport wired to it.
 */
export async function createEndpointSession(upstream: Upstream): Promise<McpEndpointSession> {
  const info = upstream.info;

  const server = new Server(
    { name: info.serverInfo.name, version: info.serverInfo.version, ...(info.instructions ? { instructions: info.instructions } : {}) },
    { capabilities: info.capabilities },
  );

  // The SDK answers `logging/setLevel` itself when the server advertises the
  // `logging` capability. We are a proxy: the upstream owns that state, so drop
  // the built-in handler and let the fallback relay it.
  server.removeRequestHandler('logging/setLevel');

  server.fallbackRequestHandler = async (request: JSONRPCRequest, extra) => {
    const params = isRecord(request.params) ? { ...request.params } : request.params;
    const warrenToken = readProgressToken(params);
    if (isRecord(params) && isRecord(params._meta) && 'progressToken' in params._meta) {
      const meta = { ...params._meta } as Record<string, unknown>;
      delete meta.progressToken;
      params._meta = meta;
    }

    return upstream.request(request.method, params, {
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(warrenToken !== undefined
        ? {
            onProgress: (progress: Record<string, unknown>) => {
              void server
                .notification(
                  { method: 'notifications/progress', params: { progressToken: warrenToken, ...progress } },
                  { relatedRequestId: extra.requestId },
                )
                .catch(() => {
                  /* Warren already went away. */
                });
            },
          }
        : {}),
    }) as Promise<Result>;
  };

  server.fallbackNotificationHandler = async (notification) => {
    await upstream.notification(notification.method, notification.params);
  };

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unsubscribe();
    await transport.close();
    await server.close();
  };
  transport.onclose = () => {
    void close();
  };
  const unsubscribe = upstream.subscribe((notification: UpstreamNotification) => {
    void server
      .notification({ method: notification.method, ...(notification.params !== undefined ? { params: notification.params } : {}) })
      .catch(() => {
        /* No live stream for this session right now; the notification is dropped. */
      });
  });

  await server.connect(transport);

  return { server, transport, get sessionId() { return transport.sessionId; }, close };
}

/** Options for {@link createMcpEndpointHandler}. */
export interface McpEndpointHandlerOptions {
  /** Name of the proxied server, used for diagnostics. */
  name: string;
  /** Resolves the upstream for an incoming request; throw to fail the request. */
  upstream: Upstream | (() => Upstream);
  /** Called when a Warren session is created (T2 uses this to bind tunnel state). */
  onSession?: (session: McpEndpointSession) => void;
}

export interface McpEndpointHandler {
  /** Handles GET/POST/DELETE for a single `/mcp/<name>` route. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of live Warren sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

/**
 * Builds the request handler for one `/mcp/<name>` route. Sessions are keyed by the
 * `Mcp-Session-Id` the transport generates during `initialize`.
 */
export function createMcpEndpointHandler(options: McpEndpointHandlerOptions): McpEndpointHandler {
  assertValidServerName(options.name);
  const sessions = new Map<string, McpEndpointSession>();
  const resolveUpstream = typeof options.upstream === 'function' ? options.upstream : () => options.upstream as Upstream;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headerSessionId = firstHeader(req, 'mcp-session-id');

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 413, jsonRpcError(null, -32700, (error as Error).message));
        return;
      }

      let session: McpEndpointSession | undefined = headerSessionId ? sessions.get(headerSessionId) : undefined;

      if (!session) {
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: no such session'));
          return;
        }
        let upstream: Upstream;
        try {
          upstream = resolveUpstream();
        } catch (error) {
          sendJson(res, 503, jsonRpcError(null, -32050, (error as Error).message, { source: 'mcp-websocket-proxy' }));
          return;
        }
        const created = await createEndpointSession(upstream);
        created.transport.onsessioninitialized = (sessionId: string) => {
          sessions.set(sessionId, created);
          options.onSession?.(created);
        };
        created.transport.onclose = () => {
          if (created.sessionId) sessions.delete(created.sessionId);
        };
        session = created;
      }

      await session.transport.handleRequest(req, res, body);
      if (session.sessionId) sessions.set(session.sessionId, session);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = headerSessionId ? sessions.get(headerSessionId) : undefined;
      if (!session) {
        sendJson(res, 400, jsonRpcError(null, -32000, 'Bad Request: no such session'));
        return;
      }
      await session.transport.handleRequest(req, res);
      if (req.method === 'DELETE' && session.sessionId) {
        sessions.delete(session.sessionId);
        await session.close();
      }
      return;
    }

    res.writeHead(405, { allow: 'GET, POST, DELETE' });
    res.end();
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
  if (!isRecord(params)) return undefined;
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
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
  return JSON.parse(text) as unknown;
}

function jsonRpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Re-exported so callers can produce `server_down`-style failures without importing errors.ts. */
export { proxyError };

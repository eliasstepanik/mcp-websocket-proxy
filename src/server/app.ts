/**
 * The Warren-side HTTP server (T2d): one `node:http` listener that also carries the
 * tunnel WebSocket upgrade on the **same** port.
 *
 * Routes:
 * - `upgrade /tunnel`               -> a {@link TunnelHandler} per socket
 *                                      (authentication is added in T3; every
 *                                      `/tunnel` upgrade is accepted for now)
 * - `POST/GET/DELETE /mcp/<name>`   -> one {@link McpEndpointHandler} per server
 *                                      name, bound to `upstreams.get(name)`
 * - `GET /healthz`                  -> `200 {"status":"ok"}`
 *
 * Wiring between the layers: {@link TunnelUpstreams} resolves the tunnel that
 * currently serves a name through a `clientId -> tunnel` map, so the app keeps that
 * map correct from registry events alone:
 *
 * - `server_up`       -> `upstreams.track(clientId, handler)` (a `hello` is only
 *                        observable through the registry, and every connection that
 *                        owns a name has said `server_up` for it)
 * - `connection_lost` -> `upstreams.untrack(clientId)`
 * - socket close      -> `upstreams.untrack(clientId)`, but only while that
 *                        connection is still the tracked one: a socket replaced by a
 *                        reconnect must not untrack its replacement.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';

import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE } from '../shared/errors.js';
import { MAX_BODY_BYTES, SERVER_NAME_PATTERN, createMcpEndpointHandler, type McpEndpointHandler } from './mcp-endpoint.js';import { Registry, type WsLike } from './registry.js';
import { TunnelUpstreams, type TunnelUpstreamTransport } from './tunnel-upstream.js';
import { TunnelHandler } from './tunnel.js';

export interface AppOptions {
  /** Registry to use. Default: a fresh one. */
  registry?: Registry<WsLike>;
  /** Upstream manager to use. Default: a fresh one over `registry`. */
  upstreams?: TunnelUpstreams;
  /** Tunnel keepalive interval, forwarded to every {@link TunnelHandler}. */
  heartbeatIntervalMs?: number;
  /** Default per-request deadline, forwarded to every {@link TunnelHandler}. */
  requestTimeoutMs?: number;
  /**
   * Size limit for tunnel frames (`ws` `maxPayload`) and for declared HTTP POST
   * bodies (`content-length`). Default {@link MAX_BODY_BYTES}; the endpoint applies
   * its own limit to chunked bodies.
   */
  maxBodyBytes?: number;
  /** Idle TTL for Warren sessions, forwarded to every endpoint handler. */
  sessionIdleTtlMs?: number;
  /** Reported as `welcome.serverVersion`. */
  serverVersion?: string;
}

export interface App {
  readonly httpServer: HttpServer;
  readonly registry: Registry<WsLike>;
  readonly upstreams: TunnelUpstreams;
  close(): Promise<void>;
}

/** `/mcp/<name>` (an optional trailing slash is tolerated). */
const MCP_ROUTE_RE = /^\/mcp\/([^/?#]+)\/?$/;

/**
 * Builds the single-port server: HTTP MCP endpoints plus the tunnel WebSocket
 * upgrade on the same listener. The returned server is **not** listening yet;
 * the caller calls `httpServer.listen(...)`.
 */
export function createApp(options: AppOptions = {}): App {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const registry = options.registry ?? new Registry<WsLike>();
  const upstreams = options.upstreams ?? new TunnelUpstreams(registry);

  /** One endpoint handler per server name, created on first use. */
  const endpoints = new Map<string, McpEndpointHandler>();
  /** The live tunnel per socket (the `clientId` is only known after `hello`). */
  const tunnelsBySocket = new Map<WsLike, TunnelUpstreamTransport>();
  /** The tunnel currently tracked in `upstreams`, per `clientId`. */
  const trackedByClient = new Map<string, TunnelUpstreamTransport>();

  const endpointFor = (name: string): McpEndpointHandler => {
    let endpoint = endpoints.get(name);
    if (!endpoint) {
      endpoint = createMcpEndpointHandler({
        name,
        // Resolved per call: the endpoint must see a reconnect (or a name that went
        // `offline`) without rebuilding the handler.
        upstream: () => upstreams.get(name),
        ...(options.sessionIdleTtlMs !== undefined ? { sessionIdleTtlMs: options.sessionIdleTtlMs } : {}),
      });
      endpoints.set(name, endpoint);
    }
    return endpoint;
  };

  /** The tunnel that currently serves `clientId`, via the registry's live socket. */
  const tunnelForClient = (clientId: string): TunnelUpstreamTransport | undefined => {
    const connection = registry.get(clientId);
    return connection ? tunnelsBySocket.get(connection.ws) : undefined;
  };

  const track = (clientId: string, tunnel: TunnelUpstreamTransport): void => {
    upstreams.track(clientId, tunnel);
    trackedByClient.set(clientId, tunnel);
  };

  /** Forget `clientId` only when `tunnel` is still the tracked one. */
  const untrack = (clientId: string, tunnel?: TunnelUpstreamTransport): void => {
    const current = trackedByClient.get(clientId);
    if (!current || (tunnel !== undefined && current !== tunnel)) return;
    trackedByClient.delete(clientId);
    upstreams.untrack(clientId);
  };

  // Registry events are the only place a `clientId` becomes observable, so the
  // tunnel map is maintained from them: a connection that owns a name has said
  // `server_up` for it, and `connection_lost` fires exactly when the registry
  // forgets a connection (a socket replaced by a reconnect emits neither).
  const offRegistry = registry.on((event) => {
    if (event.type === 'server_up') {
      const tunnel = tunnelForClient(event.clientId);
      if (tunnel) track(event.clientId, tunnel);
      return;
    }
    if (event.type === 'connection_lost') untrack(event.clientId);
  });

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const match = MCP_ROUTE_RE.exec(path);
    if (match) {
      const name = decodeURIComponent(match[1] ?? '');
      if (!SERVER_NAME_PATTERN.test(name)) {
        sendJsonRpc(res, 404, `Not Found: invalid server name ${JSON.stringify(name)}`);
        return;
      }
      // The endpoint enforces the limit on the stream; this catches a declared
      // `content-length` before the body is read at all.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        sendJsonRpc(res, 413, `Request body too large (limit ${maxBodyBytes} bytes)`, 'too_large');
        return;
      }
      void endpointFor(name)
        .handle(req, res)
        .catch(() => {
          /* the endpoint answers its own failures */
        });
      return;
    }

    sendJsonRpc(res, 404, `Not Found: ${path}`);
  };

  const httpServer = createServer(handleRequest);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxBodyBytes,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== '/tunnel') {
      // Nothing else upgrades: answer like a plain 404 so a client can tell a wrong
      // path from a dead server.
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // T3 adds authentication here; every `/tunnel` upgrade is accepted for now.
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handler = new TunnelHandler(ws, registry, {
        ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(options.serverVersion !== undefined ? { serverVersion: options.serverVersion } : {}),
      });
      tunnelsBySocket.set(ws, handler);
      ws.on('close', () => {
        tunnelsBySocket.delete(ws);
        const clientId = handler.clientIdValue;
        if (clientId !== undefined) untrack(clientId, handler);
      });
    });
  });

  const close = async (): Promise<void> => {
    offRegistry();
    await Promise.all([...endpoints.values()].map((endpoint) => endpoint.close()));
    endpoints.clear();
    await Promise.all(
      [...wss.clients].map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.once('close', () => resolve());
            try {
              ws.close(1001, 'server shutting down');
            } catch {
              resolve();
            }
          }),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    tunnelsBySocket.clear();
    trackedByClient.clear();
  };

  return { httpServer, registry, upstreams, close };
}

/** A JSON-RPC-shaped error for routing failures (unknown route or server name). */
function sendJsonRpc(res: ServerResponse, status: number, message: string, reason?: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: reason === undefined ? -32000 : PROXY_ERROR_CODE,
        message,
        ...(reason === undefined ? {} : { data: { source: PROXY_ERROR_SOURCE, reason } }),
      },
    }),
  );
}

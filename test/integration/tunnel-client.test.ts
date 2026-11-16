/**
 * T2 proof: the client-side {@link TunnelClient} dials out to a real server-side
 * {@link TunnelHandler} and proxies requests to live stdio children.
 *
 * Topology under test (all in-process, two child processes):
 *
 *   TunnelClient (src/client/tunnel-client.ts)
 *     -> node:http server on 127.0.0.1:0 -> `upgrade` -> WebSocketServer(noServer)
 *       -> new TunnelHandler(ws, registry)
 *   TunnelClient.servers
 *     -> LocalMcpServer x2 -> test/fixtures/fake-mcp-server.mjs
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { TunnelHandler, UpstreamRpcError } from '../../src/server/tunnel.js';
import { Registry, type WsLike } from '../../src/server/registry.js';
import { LocalMcpServer } from '../../src/client/local-server.js';
import { TunnelClient } from '../../src/client/tunnel-client.js';
import type { UpstreamProgress } from '../../src/shared/upstream.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let httpServer: HttpServer;
let wss: WebSocketServer;
let registry: Registry<WsLike>;
let handlers: TunnelHandler[];
let url = '';
/** `authorization` headers seen on the upgrade requests, in arrival order. */
let authHeaders: Array<string | undefined> = [];
/** The server-side sockets, so a test can drop one and watch the client reconnect. */
let sockets: WebSocket[];
let handlerOverrides: ConstructorParameters<typeof TunnelHandler>[2] = {};

let client: TunnelClient | undefined;
let locals: Map<string, LocalMcpServer>;

const latestHandler = (): TunnelHandler => {
  const handler = handlers[handlers.length - 1];
  if (!handler) throw new Error('no tunnel handler on the server side');
  return handler;
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Starts two fixture children and the tunnel client that exposes them. */
async function startTunnel(): Promise<void> {
  locals = new Map();
  for (const name of ['alpha', 'beta']) {
    const local = new LocalMcpServer({
      name,
      command: process.execPath,
      args: [FIXTURE],
      restart: false,
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
    });
    await local.start();
    locals.set(name, local);
  }
  client = new TunnelClient({
    url,
    token: 'test-token',
    clientId: 'pc-test',
    clientVersion: '9.9.9',
    servers: locals,
  });
  await waitFor(() => registry.lookup('alpha')?.up === true && registry.lookup('beta')?.up === true, 'both servers to be up');
}

async function stopTunnel(): Promise<void> {
  client?.stop();
  client = undefined;
  for (const handler of handlers) handler.close();
  handlers = [];
  for (const local of locals?.values() ?? []) await local.stop();
}

beforeAll(async () => {
  registry = new Registry<WsLike>();
  handlers = [];
  sockets = [];
  httpServer = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    authHeaders.push(req.headers.authorization);
    wss.handleUpgrade(req, socket as never, head, (ws: WebSocket) => {
      sockets.push(ws);
      handlers.push(new TunnelHandler(ws, registry, { serverVersion: 'test-1.2.3', ...handlerOverrides }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  url = `ws://127.0.0.1:${address.port}/tunnel`;
});

afterAll(async () => {
  wss.close();
  httpServer.closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(async () => {
  authHeaders = [];
  sockets = [];
  handlerOverrides = {};
  await startTunnel();
});

afterEach(async () => {
  await stopTunnel();
  registry = new Registry<WsLike>();
});

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------

describe('handshake', () => {
  it('dials out with the bearer token, says hello and registers both servers', async () => {
    expect(client?.state).toBe('connected');
    expect(authHeaders).toEqual(['Bearer test-token']);
    expect(registry.connectionCount).toBe(1);
    expect(registry.get('pc-test')?.clientId).toBe('pc-test');

    const servers = registry.listServers();
    expect(servers.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(servers.every((s) => s.up)).toBe(true);
    expect(servers.every((s) => s.clientId === 'pc-test')).toBe(true);
    // The info is the fixture's own captured `initialize` result.
    expect(servers[0]?.info.serverInfo).toMatchObject({ name: 'fake-mcp-server', version: '1.2.3' });
    expect(servers[0]?.info.instructions).toBe('Fixture server used by mcp-websocket-proxy tests.');
  });

  it('answers a request for an unknown server with -32601', async () => {
    const error = (await latestHandler()
      .sendRequest('gamma', { method: 'tools/list' })
      .catch((e: unknown) => e)) as UpstreamRpcError;
    expect(error).toBeInstanceOf(UpstreamRpcError);
    expect(error.code).toBe(-32601);
  });
});

// ---------------------------------------------------------------------------
// request relay
// ---------------------------------------------------------------------------

describe('request relay', () => {
  it('relays a tools/call to the right fixture child', async () => {
    const result = await latestHandler().sendRequest('beta', {
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello' } },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:hello' }] });
  });

  it('relays upstream JSON-RPC errors with their raw code and data', async () => {
    const error = (await latestHandler()
      .sendRequest('alpha', { method: 'tools/call', params: { name: 'echo', arguments: { text: '__error__' } } })
      .catch((e: unknown) => e)) as UpstreamRpcError;
    expect(error).toBeInstanceOf(UpstreamRpcError);
    expect(error.code).toBe(-32100);
    expect(error.message).toBe('fixture refuses to echo');
    expect(error.data).toEqual({ fixture: true });
  });

  it('emits progress frames when wantProgress is set', async () => {
    const seen: UpstreamProgress[] = [];
    const result = await latestHandler().sendRequest('alpha', {
      method: 'tools/call',
      params: { name: 'progress', arguments: { steps: 3 } },
      wantProgress: true,
      onProgress: (p) => seen.push(p),
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'progress:done:3' }] });
    expect(seen.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ total: 3, message: 'step 1/3' });
  });

  it('aborts the local call when the server sends cancel', async () => {
    const controller = new AbortController();
    const pending = latestHandler().sendRequest('alpha', {
      method: 'tools/call',
      params: { name: 'slow', arguments: { ms: 5_000 } },
      signal: controller.signal,
    });
    // Let the request reach the fixture before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort('user cancelled');
    await pending.catch(() => undefined);

    // The fixture records the abort on its own signal: proof the cancel travelled
    // all the way into the child process. The reason is the tunnel's own
    // `client_cancelled` reason, not the caller's abort reason.
    const state = await readState('alpha');
    expect(state.lastCancellation).not.toBeNull();
    expect(String((state.lastCancellation as { reason?: string }).reason)).toContain('cancelled');
  });
});

/** Reads a fixture child's observable state through the tunnel. */
async function readState(server: string): Promise<Record<string, unknown>> {
  const result = (await latestHandler().sendRequest(server, {
    method: 'resources/read',
    params: { uri: 'fixture://state' },
  })) as { contents: Array<{ text?: string }> };
  return JSON.parse(result.contents[0]?.text ?? '{}') as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// local server state changes
// ---------------------------------------------------------------------------

describe('server_up / server_down on local state changes', () => {
  it('reports server_down when a child stops and server_up again when it restarts', async () => {
    const alpha = locals.get('alpha');
    if (!alpha) throw new Error('alpha is not wired up');

    await alpha.stop();
    await waitFor(() => registry.lookup('alpha')?.up === false, 'alpha to be marked down');
    expect(registry.lookup('beta')?.up).toBe(true);

    await alpha.start();
    await waitFor(() => registry.lookup('alpha')?.up === true, 'alpha to be advertised again');
  });
});

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

describe('reconnect', () => {
  it('re-dials after the socket is killed and re-registers every server', async () => {
    const firstSocket = sockets[0];
    if (!firstSocket) throw new Error('no server-side socket to kill');
    firstSocket.terminate();

    await waitFor(() => client?.state === 'reconnecting', 'the client to start reconnecting');
    await waitFor(
      () => registry.connectionCount === 1 && registry.lookup('alpha')?.up === true && registry.lookup('beta')?.up === true,
      'the tunnel to come back with both servers up',
    );
    expect(client?.state).toBe('connected');
    // Two upgrade requests: the original dial and the reconnect, both authenticated.
    expect(authHeaders).toEqual(['Bearer test-token', 'Bearer test-token']);

    // The new connection really works end to end.
    const result = await latestHandler().sendRequest('alpha', {
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'again' } },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:again' }] });
  });

  it('stops reconnecting on stop() and closes with 1001', async () => {
    const socket = sockets[sockets.length - 1];
    const closed = new Promise<number>((resolve) => socket?.once('close', (code: number) => resolve(code)));
    client?.stop();
    expect(client?.state).toBe('stopped');
    expect(await closed).toBe(1001);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registry.connectionCount).toBe(0);
    expect(client?.state).toBe('stopped');
  });
});

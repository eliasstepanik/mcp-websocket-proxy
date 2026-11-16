/**
 * Disconnect / reconnect acceptance cases, end to end (same topology as
 * `test/integration/e2e.test.ts`, with short heartbeat/request timeouts so the
 * failure paths are observable in well under a second):
 *
 *   test (SDK `Client` + `StreamableHTTPClientTransport`, plus raw `fetch`)
 *     -> createApp(): node:http on 127.0.0.1:0
 *     -> TunnelClient (the "work PC")
 *        -> LocalMcpServer x2 -> test/fixtures/fake-mcp-server.mjs
 *
 * Cases: (a) nothing connected, (b) the client dies mid-call, (c) reconnect with
 * the same Warren session id + a synthetic `list_changed` after down->up,
 * (d) a silently dropped socket found by the heartbeat, (e) takeover by a second
 * connection with the same `clientId`, (f) a name conflict from another
 * `clientId`, (g) a request deadline that reaches Warren *and* the client.
 */

import { connect, createServer as createNetServer, type Socket } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { createApp, type App } from '../../src/server/app.js';
import { bearerHeader } from '../../src/server/auth.js';
import { LocalMcpServer } from '../../src/client/local-server.js';
import { TunnelClient } from '../../src/client/tunnel-client.js';
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE } from '../../src/shared/errors.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

const CLIENT_ID = 'disc-pc';
const CLIENT_TOKEN = 'disc-client-token-aaaaaaaaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'disc-endpoint-token-bbbbbbbbbbbbbbbbb';

/** Keepalive interval used by the app under test: a dead socket is found in ~2 ticks. */
const HEARTBEAT_MS = 150;

let app: App | undefined;
let baseUrl = '';
let tunnelUrl = '';
let client: TunnelClient | undefined;
/** Every tunnel started since the last `stopTunnel`, so none can leak. */
let tunnels: TunnelClient[] = [];
let locals: Map<string, LocalMcpServer>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Builds a fresh app (own listener) so each case can tune its own timeouts. */
async function startApp(options: { heartbeatIntervalMs?: number; requestTimeoutMs?: number } = {}): Promise<void> {
  app = createApp({
    clientToken: CLIENT_TOKEN,
    endpointToken: ENDPOINT_TOKEN,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_MS,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  await new Promise<void>((resolve) => app!.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
  tunnelUrl = `ws://127.0.0.1:${address.port}/tunnel`;
}

async function stopApp(): Promise<void> {
  await app?.close();
  app = undefined;
}

/** Spawns the two fixture children (no tunnel yet). */
async function makeLocals(): Promise<Map<string, LocalMcpServer>> {
  const servers = new Map<string, LocalMcpServer>();
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
    servers.set(name, local);
  }
  return servers;
}

/** Starts the tunnel client over `locals` and waits for both names to be up. */
async function startTunnel(options: { clientId?: string; servers?: Map<string, LocalMcpServer>; url?: string } = {}): Promise<TunnelClient> {
  locals = options.servers ?? locals ?? (await makeLocals());
  const tunnel = new TunnelClient({
    url: options.url ?? tunnelUrl,
    token: CLIENT_TOKEN,
    clientId: options.clientId ?? CLIENT_ID,
    servers: locals,
  });
  client = tunnel;
  tunnels.push(tunnel);
  await waitFor(
    () => app?.registry.lookup('alpha')?.up === true && app?.registry.lookup('beta')?.up === true,
    'both fixture servers to be registered',
  );
  return tunnel;
}

async function stopTunnel(): Promise<void> {
  for (const tunnel of tunnels.splice(0)) tunnel.stop();
  client = undefined;
  for (const local of locals?.values() ?? []) await local.stop();
}

/** The `ws.WebSocket` a {@link TunnelClient} currently holds (private field, reached on purpose). */
function socketOf(tunnel: TunnelClient): { terminate(): void; readyState: number; _autoPong?: boolean } {
  const ws = (tunnel as unknown as { ws?: { terminate(): void; readyState: number; _autoPong?: boolean } }).ws;
  if (!ws) throw new Error('the tunnel client has no live socket');
  return ws;
}

/** One Warren session on `/mcp/<name>`, with a copy of every inbound notification. */
async function connectServer(
  name: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport; notifications: string[] }> {
  const notifications: string[] = [];
  const warren = new Client({ name: 'warren-disc', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${name}`), {
    requestInit: { headers: { authorization: bearerHeader(ENDPOINT_TOKEN) } },
  });
  transport.onmessage = (message) => {
    const candidate = message as { method?: unknown };
    if (typeof candidate.method === 'string' && !('id' in message)) notifications.push(candidate.method);
  };
  await warren.connect(transport);
  return { client: warren, transport, notifications };
}

/** A bare `initialize` POST, for the paths the SDK client cannot reach (503, kept session ids). */
async function rawInitialize(name: string): Promise<Response> {
  return await fetch(`${baseUrl}/mcp/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: bearerHeader(ENDPOINT_TOKEN),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'warren-raw', version: '1.0.0' } },
    }),
  });
}

/** One raw JSON-RPC request on an existing session. */
async function rawPost(name: string, sessionId: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}/mcp/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      authorization: bearerHeader(ENDPOINT_TOKEN),
    },
    body: JSON.stringify(body),
  });
}

/** Reads a fixture child's observable state through its own Warren session. */
async function readFixtureState(warren: Client): Promise<Record<string, unknown>> {
  const result = await warren.readResource({ uri: 'fixture://state' });
  const first = result.contents[0];
  if (!first || !('text' in first) || typeof first.text !== 'string') throw new Error('fixture://state did not return text');
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Pulls the JSON-RPC error out of a failed SDK call. */
async function errorOf(promise: Promise<unknown>): Promise<McpError> {
  return (await promise.then(() => undefined).catch((e: unknown) => e)) as McpError;
}

/** Waits until `predicate` matches one of the sniffed `frames`. */
async function waitForFrame(frames: string[], predicate: (frame: string) => boolean, label: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Records every frame the server sends to `tunnel`, alongside the client's own
 * handling of them (a second `message` listener on the same socket).
 */
function sniffFrames(tunnel: TunnelClient): string[] {
  const frames: string[] = [];
  const ws = socketOf(tunnel) as unknown as { on(event: 'message', cb: (data: unknown) => void): void };
  ws.on('message', (data: unknown) => {
    frames.push(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'));
  });
  return frames;
}

/**
 * A TCP proxy in front of `/tunnel` that can stop forwarding **without closing
 * anything**: neither side ever sees a FIN, so the client's socket stays open and
 * silent forever. That is the "silently dropped socket" the heartbeat must catch.
 */
async function startStallingProxy(): Promise<{ url: string; stall(): void; stop(): Promise<void> }> {
  const upstreamPort = Number(new URL(tunnelUrl).port);
  const open = new Set<Socket>();
  const server = createNetServer((clientSocket) => {
    const upstream = connect({ host: '127.0.0.1', port: upstreamPort });
    open.add(clientSocket);
    open.add(upstream);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    clientSocket.on('error', () => undefined);
    upstream.on('error', () => undefined);
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind the stalling proxy');
  return {
    url: `ws://127.0.0.1:${address.port}/tunnel`,
    // `pause()` stops forwarding the bytes that arrive; the sockets stay open.
    stall: () => {
      for (const socket of open) socket.pause();
    },
    stop: async () => {
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// One app + one tunnel per test: a case that needs different heartbeat/request
// timeouts replaces the app inside the test with `restartApp`.
beforeEach(async () => {
  await startApp();
  await startTunnel();
});

afterEach(async () => {
  await stopTunnel();
  await stopApp();
});

/** Throws away the app the harness built and starts one with `options`. */
async function restartApp(options: { heartbeatIntervalMs?: number; requestTimeoutMs?: number }): Promise<void> {
  for (const tunnel of tunnels.splice(0)) tunnel.stop();
  client = undefined;
  await stopApp();
  await startApp(options);
  await startTunnel();
}

// ---------------------------------------------------------------------------
// (a) nothing is connected
// ---------------------------------------------------------------------------

describe('disconnect (a): zero clients', () => {
  it('answers /healthz 200 and initialize with 503 + -32050 offline + retry-after', async () => {
    // Tear the tunnel down and wait for the names to leave the registry.
    client?.stop();
    client = undefined;
    await waitFor(() => app?.registry.lookup('alpha') === undefined, 'alpha to leave the registry', 10_000);

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const offline = await rawInitialize('alpha');
    expect(offline.status).toBe(503);
    expect(offline.headers.get('retry-after')).toBe('10');
    const body = (await offline.json()) as { error: { code: number; data?: { source?: string; reason?: string } } };
    expect(body.error.code).toBe(PROXY_ERROR_CODE);
    expect(body.error.data).toEqual({ source: PROXY_ERROR_SOURCE, reason: 'offline' });
  });
});

// ---------------------------------------------------------------------------
// (b) the client dies while a call is in flight
// ---------------------------------------------------------------------------

describe('disconnect (b): the tunnel dies mid-call', () => {
  it('rejects the pending call with -32050 client_disconnected and keeps serving', async () => {
    const alpha = await connectServer('alpha');
    const pending = alpha.client.callTool({ name: 'slow', arguments: { ms: 10_000 } });

    // Give the request time to reach the fixture child before killing the socket.
    await waitFor(async () => (await readFixtureState(alpha.client)).calls === 1, 'the slow call to reach the child', 10_000);

    const startedAt = Date.now();
    socketOf(client!).terminate();

    const error = await errorOf(pending);
    const elapsed = Date.now() - startedAt;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(PROXY_ERROR_CODE);
    expect((error.data as { source?: string; reason?: string })).toMatchObject({
      source: PROXY_ERROR_SOURCE,
      reason: 'client_disconnected',
    });
    // Heartbeat (150ms) plus a full second of slack: the failure is prompt, not a
    // hang until the SDK's own 60s request timeout.
    expect(elapsed).toBeLessThan(HEARTBEAT_MS * 2 + 1_000);

    // The proxy itself is untouched: the name is simply offline again.
    await waitFor(() => app?.registry.lookup('alpha') === undefined, 'alpha to leave the registry', 10_000);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);

    await alpha.client.close();
  });
});

// ---------------------------------------------------------------------------
// (c) reconnect with the same Warren session id + synthetic list_changed
// ---------------------------------------------------------------------------

describe('disconnect (c): reconnect with the same session id', () => {
  it('serves the kept session id again and sends a synthetic tools/list_changed on down->up', async () => {
    const alpha = await connectServer('alpha');
    const sessionId = alpha.transport.sessionId!;
    expect(sessionId).toBeTruthy();

    let listChanged = 0;
    alpha.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged += 1;
    });
    // Establish the standalone GET stream the notification needs.
    await alpha.client.listTools();

    // Down: the local child stops (the tunnel itself stays up), so the name is
    // registered but down.
    const local = locals.get('alpha');
    if (!local) throw new Error('alpha is not wired up');
    await local.stop();
    await waitFor(() => app?.registry.lookup('alpha')?.up === false, 'alpha to be marked down', 10_000);

    // Up again: the child restarts and re-advertises itself.
    await local.start();
    await waitFor(() => app?.registry.lookup('alpha')?.up === true, 'alpha to be advertised again', 20_000);

    // The proxy synthesises the notification Warren would have missed while the
    // server was down (the child's own list may or may not have changed).
    await waitFor(() => listChanged > 0, 'a synthetic notifications/tools/list_changed', 10_000);
    expect(alpha.notifications).toContain('notifications/tools/list_changed');

    // The same Warren session id still works, with no re-initialize.
    expect(await alpha.client.callTool({ name: 'echo', arguments: { text: 'after' } })).toEqual({
      content: [{ type: 'text', text: 'echo:after' }],
    });
    expect(alpha.transport.sessionId).toBe(sessionId);

    // And a *new* initialize on the same route succeeds too (the name is up again).
    const reinitialized = await rawInitialize('alpha');
    expect(reinitialized.status).toBe(200);
    await reinitialized.body?.cancel();

    // A raw request on the kept session id works as well.
    const echo = await rawPost('alpha', sessionId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'raw' } },
    });
    expect(echo.status).toBe(200);
    expect(await echo.text()).toContain('echo:raw');

    await alpha.client.close();
  });
});

// ---------------------------------------------------------------------------
// (d) a socket that dies without a close event
// ---------------------------------------------------------------------------

describe('disconnect (d): a silently dropped socket', () => {
  it('is found by the heartbeat and the registry marks the servers down', async () => {
    // A TCP proxy that can stop forwarding without closing anything: from the
    // client's side the socket stays open forever (no FIN, no close event).
    const proxy = await startStallingProxy();
    client?.stop();
    client = undefined;
    await waitFor(() => app?.registry.connectionCount === 0, 'the first tunnel to go away', 10_000);

    const stalled = await startTunnel({ url: proxy.url });
    const startedAt = Date.now();
    proxy.stall();

    await waitFor(() => app?.registry.lookup('alpha') === undefined, 'alpha to leave the registry', 5_000);
    const elapsed = Date.now() - startedAt;
    expect(app?.registry.lookup('beta')).toBeUndefined();
    expect(app?.registry.connectionCount).toBe(0);
    // Two heartbeat ticks (ping, then the unanswered ping) plus slack: the drop was
    // detected by the keepalive, not by a close event.
    expect(elapsed).toBeGreaterThanOrEqual(HEARTBEAT_MS);
    expect(elapsed).toBeLessThan(HEARTBEAT_MS * 2 + 1_000);

    // The client noticed nothing: its socket is still open and it still believes it
    // is connected, which is exactly what the server-side heartbeat is for.
    expect(stalled.state).toBe('connected');
    expect(socketOf(stalled).readyState).toBe(1);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);

    await proxy.stop();
  });
});

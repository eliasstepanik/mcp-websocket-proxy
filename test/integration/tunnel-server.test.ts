/**
 * T2 integration proof: the server-side {@link TunnelHandler} speaks the tunnel
 * protocol with a raw `ws` client over a real HTTP upgrade.
 *
 * Topology under test (all in-process, no child processes):
 *
 *   test (raw `ws` client speaking the tunnel protocol)
 *     -> node:http server on 127.0.0.1:0 -> `upgrade` -> WebSocketServer(noServer)
 *       -> new TunnelHandler(ws, registry)
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import {
  CLOSE_CODE_HELLO_TIMEOUT,
  CLOSE_CODE_PROTOCOL,
  TunnelHandler,
  UpstreamRpcError,
  type SendRequestOptions,
} from '../../src/server/tunnel.js';
import { CLOSE_CODE_REPLACED, Registry, REASON_CONNECTION_LOST, type WsLike } from '../../src/server/registry.js';
import { PROTOCOL_VERSION, parseTunnelMessage, type ServerToClient } from '../../src/shared/protocol.js';
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE, isProxyError } from '../../src/shared/errors.js';
import type { UpstreamInfo } from '../../src/shared/upstream.js';

const info = (name: string): UpstreamInfo => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name, version: '1.0.0' },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let httpServer: HttpServer;
let wss: WebSocketServer;
let registry: Registry<WsLike>;
let handlers: TunnelHandler[];
let url = '';
let nextClientId = 1;

/** Options applied to handlers created after this is set (per-test tuning). */
let handlerOverrides: ConstructorParameters<typeof TunnelHandler>[2] = {};

/** A raw tunnel client: keeps an inbox so no frame can be missed. */
class TestClient {
  readonly ws: WebSocket;
  readonly inbox: ServerToClient[] = [];
  /** Frames that did not validate as server -> server traffic (e.g. an `invalid_name` ack). */
  readonly badFrames: string[] = [];
  private waiters: Array<(msg: ServerToClient) => void> = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      let msg: ServerToClient;
      try {
        msg = parseTunnelMessage(text, 'out') as ServerToClient;
      } catch {
        this.badFrames.push(text);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.inbox.push(msg);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.closes.push({ code, reason: reason.toString('utf8') });
    });
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The next frame the server sends (from the inbox first). */
  next(timeoutMs = 5_000): Promise<ServerToClient> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<ServerToClient>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a tunnel frame')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  /** The next frame of `type`, skipping (and keeping) anything else. */
  async expect<K extends ServerToClient['type']>(type: K, timeoutMs = 5_000): Promise<Extract<ServerToClient, { type: K }>> {
    for (;;) {
      const msg = await this.next(timeoutMs);
      if (msg.type === type) return msg as Extract<ServerToClient, { type: K }>;
    }
  }

  async closed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const last = this.closes[this.closes.length - 1];
      if (last) return last;
      if (Date.now() > deadline) throw new Error('timed out waiting for close');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}

const clients: TestClient[] = [];

async function connect(options: { clientId?: string; hello?: boolean } = {}): Promise<TestClient> {
  const client = new TestClient(new WebSocket(url));
  clients.push(client);
  await client.open();
  const clientId = options.clientId ?? `pc-${nextClientId++}`;
  if (options.hello !== false) {
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId });
    await client.expect('welcome');
  }
  (client as TestClient & { clientId: string }).clientId = clientId;
  return client;
}

function idOf(client: TestClient): string {
  return (client as TestClient & { clientId: string }).clientId;
}

function sendRequest(server: string, options: SendRequestOptions): Promise<unknown> {
  const handler = handlers[handlers.length - 1];
  if (!handler) throw new Error('no tunnel handler on the server side');
  return handler.sendRequest(server, options);
}

function subscribe(server: string, cb: (n: { method: string; params?: unknown }) => void): () => void {
  const handler = handlers[handlers.length - 1];
  if (!handler) throw new Error('no tunnel handler on the server side');
  return handler.subscribeNotifications(server, cb);
}

beforeAll(async () => {
  registry = new Registry<WsLike>();
  handlers = [];
  httpServer = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket as never, head, (ws) => {
      handlers.push(new TunnelHandler(ws, registry, { serverVersion: 'test-1.2.3', ...handlerOverrides }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  url = `ws://127.0.0.1:${address.port}/tunnel`;
});

afterEach(async () => {
  handlerOverrides = {};
  for (const client of clients.splice(0)) {
    try {
      client.terminate();
    } catch {
      /* already gone */
    }
  }
  handlers = [];
  registry = new Registry<WsLike>();
});

afterAll(async () => {
  wss.close();
  httpServer.closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// hello / welcome
// ---------------------------------------------------------------------------

describe('hello / welcome', () => {
  it('registers the connection on a valid hello', async () => {
    await connect({ clientId: 'pc-a' });
    expect(registry.connectionCount).toBe(1);
    expect(registry.get('pc-a')?.clientId).toBe('pc-a');
  });

  it('greets with protocol, serverVersion and the negotiated heartbeat interval', async () => {
    const client = new TestClient(new WebSocket(url));
    clients.push(client);
    await client.open();
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: 'pc-greet', clientVersion: '0.1.0' });
    const welcome = await client.expect('welcome');
    expect(welcome).toEqual({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      serverVersion: 'test-1.2.3',
      heartbeatIntervalMs: 15_000,
    });
  });

  it('closes with 4004 when no hello arrives in time', async () => {
    handlerOverrides = { helloTimeoutMs: 60 };
    const client = new TestClient(new WebSocket(url));
    clients.push(client);
    await client.open();
    const closed = await client.closed();
    expect(closed.code).toBe(CLOSE_CODE_HELLO_TIMEOUT);
  });

  it('closes with 4000 when the first frame is not a hello', async () => {
    const client = new TestClient(new WebSocket(url));
    clients.push(client);
    await client.open();
    client.send({ type: 'server_down', server: 'alpha', reason: 'nope' });
    expect((await client.closed()).code).toBe(CLOSE_CODE_PROTOCOL);
  });

  it('closes with 4000 on a frame that is not valid JSON', async () => {
    const client = new TestClient(new WebSocket(url));
    clients.push(client);
    await client.open();
    client.send({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: 'pc-json' });
    await client.expect('welcome');
    client.sendRaw('{not json');
    expect((await client.closed()).code).toBe(CLOSE_CODE_PROTOCOL);
  });

  it('closes with 4000 on an unknown message type', async () => {
    const client = await connect();
    client.sendRaw(JSON.stringify({ type: 'banana' }));
    expect((await client.closed()).code).toBe(CLOSE_CODE_PROTOCOL);
  });
});

// ---------------------------------------------------------------------------
// takeover
// ---------------------------------------------------------------------------

describe('takeover', () => {
  it('closes the previous connection with 4002 when the same clientId reconnects', async () => {
    const first = await connect({ clientId: 'pc-take' });
    await connect({ clientId: 'pc-take' });

    const closed = await first.closed();
    expect(closed.code).toBe(CLOSE_CODE_REPLACED);
    expect(registry.connectionCount).toBe(1);
    expect(registry.get('pc-take')?.clientId).toBe('pc-take');
    expect(registry.get('pc-take')?.ws).not.toBe(first.ws);
  });

  it('does not unregister the surviving connection when the replaced one dies', async () => {
    const first = await connect({ clientId: 'pc-take2' });
    const second = await connect({ clientId: 'pc-take2' });
    await first.closed();
    first.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.connectionCount).toBe(1);
    expect(registry.get('pc-take2')).toBeDefined();
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });
});

// ---------------------------------------------------------------------------
// server_up / server_down
// ---------------------------------------------------------------------------

describe('server_up / server_down', () => {
  it('acks a valid server_up and records it in the registry', async () => {
    const client = await connect({ clientId: 'pc-up' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    expect(await client.expect('server_ack')).toEqual({ type: 'server_ack', server: 'alpha', ok: true });

    const lookup = registry.lookup('alpha');
    expect(lookup?.up).toBe(true);
    expect(lookup?.info.serverInfo.name).toBe('alpha');

    client.send({ type: 'server_down', server: 'alpha', reason: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.lookup('alpha')?.up).toBe(false);
  });

  it('acks name_conflict when another client owns the name', async () => {
    const owner = await connect({ clientId: 'pc-owner' });
    owner.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await owner.expect('server_ack');

    const thief = await connect({ clientId: 'pc-thief' });
    thief.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    const ack = await thief.expect('server_ack');
    expect(ack).toMatchObject({ type: 'server_ack', server: 'alpha', ok: false, error: 'name_conflict' });
  });

  it('acks invalid_name for a malformed server name without closing', async () => {
    const client = await connect({ clientId: 'pc-bad' });
    client.send({ type: 'server_up', server: 'Bad Name!', info: info('x') });
    // The ack itself carries the invalid name, so it is not valid wire traffic:
    // read the raw frame instead.
    const deadline = Date.now() + 5_000;
    while (client.badFrames.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(client.badFrames[0] ?? '{}')).toEqual({
      type: 'server_ack',
      server: 'Bad Name!',
      ok: false,
      error: 'invalid_name',
    });
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });
});

// ---------------------------------------------------------------------------
// request / response
// ---------------------------------------------------------------------------

describe('sendRequest', () => {
  it('correlates responses by id, even out of order', async () => {
    const client = await connect({ clientId: 'pc-req' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const first = sendRequest('alpha', { method: 'tools/list', params: { a: 1 }, sessionId: 'sess-1' });
    const second = sendRequest('alpha', { method: 'tools/call', params: { name: 'x' } });

    const frameA = await client.expect('request');
    const frameB = await client.expect('request');
    const frames = [frameA, frameB];
    expect(frames.map((f) => f.server)).toEqual(['alpha', 'alpha']);
    expect(frames.map((f) => f.method).sort()).toEqual(['tools/call', 'tools/list']);
    expect(frames.find((f) => f.method === 'tools/list')).toMatchObject({ session: 'sess-1', params: { a: 1 } });
    expect(new Set(frames.map((f) => f.id)).size).toBe(2);

    const byMethod = new Map(frames.map((f) => [f.method, f.id]));
    // Answer the *second* request first.
    client.send({ type: 'response', id: byMethod.get('tools/call'), result: { content: [{ type: 'text', text: 'call' }] } });
    client.send({ type: 'response', id: byMethod.get('tools/list'), result: { tools: [] } });

    await expect(second).resolves.toEqual({ content: [{ type: 'text', text: 'call' }] });
    await expect(first).resolves.toEqual({ tools: [] });
  });

  it('rejects with UpstreamRpcError carrying the raw code, message and data', async () => {
    const client = await connect({ clientId: 'pc-err' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const pending = sendRequest('alpha', { method: 'tools/call' });
    const frame = await client.expect('request');
    client.send({
      type: 'response',
      id: frame.id,
      error: { code: -32602, message: 'unknown tool', data: { tool: 'nope' } },
    });

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRpcError);
    const rpc = error as UpstreamRpcError;
    expect(rpc.isUpstreamRpcError).toBe(true);
    expect(rpc.code).toBe(-32602);
    expect(rpc.message).toBe('unknown tool');
    expect(rpc.data).toEqual({ tool: 'nope' });
  });

  it('routes progress frames to onProgress', async () => {
    const client = await connect({ clientId: 'pc-prog' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const seen: unknown[] = [];
    const pending = sendRequest('alpha', {
      method: 'resources/read',
      wantProgress: true,
      onProgress: (p) => seen.push(p),
    });

    const frame = await client.expect('request');
    expect(frame.wantProgress).toBe(true);
    client.send({ type: 'progress', id: frame.id, params: { progress: 1, total: 2, message: 'half' } });
    client.send({ type: 'progress', id: frame.id, params: { progress: 2, total: 2 } });
    expect(seen).toEqual([
      { progress: 1, total: 2, message: 'half' },
      { progress: 2, total: 2 },
    ]);

    client.send({ type: 'response', id: frame.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    // A late progress frame for a settled request must not throw.
    client.send({ type: 'progress', id: frame.id, params: { progress: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.length).toBe(2);
  });

  it('sends cancel and rejects with an AbortError when the signal aborts', async () => {
    const client = await connect({ clientId: 'pc-abort' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const controller = new AbortController();
    const pending = sendRequest('alpha', { method: 'tools/call', signal: controller.signal });
    const frame = await client.expect('request');
    controller.abort();

    const cancel = await client.expect('cancel');
    expect(cancel.id).toBe(frame.id);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isProxyError(error)).toBe(false);
    expect((error as Error).message).toMatch(/abort/i);

    // A response arriving after the abort is ignored (nothing is in flight).
    client.send({ type: 'response', id: frame.id, result: { late: true } });
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it('sends cancel and rejects with a timeout proxyError past the deadline', async () => {
    const client = await connect({ clientId: 'pc-timeout' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const pending = sendRequest('alpha', { method: 'tools/call', timeoutMs: 80 });
    const frame = await client.expect('request');
    const cancel = await client.expect('cancel');
    expect(cancel.id).toBe(frame.id);

    const error = await pending.catch((e: unknown) => e);
    expect(isProxyError(error)).toBe(true);
    expect((error as { code: number }).code).toBe(PROXY_ERROR_CODE);
    expect((error as { data: { reason: string } }).data.reason).toBe('timeout');
  });

  it('rejects in-flight requests with client_disconnected when the connection drops', async () => {
    const client = await connect({ clientId: 'pc-lost' });
    client.send({ type: 'server_up', server: 'alpha', info: info('alpha') });
    await client.expect('server_ack');

    const pending = sendRequest('alpha', { method: 'tools/call' });
    await client.expect('request');
    client.terminate();

    const error = await pending.catch((e: unknown) => e);
    expect(isProxyError(error)).toBe(true);
    expect((error as { code: number }).code).toBe(PROXY_ERROR_CODE);
    expect((error as { data: { source: string; reason: string } }).data).toMatchObject({
      source: PROXY_ERROR_SOURCE,
      reason: 'client_disconnected',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.connectionCount).toBe(0);
    expect(registry.lookup('alpha')).toBeUndefined();
    expect(registry.listServers()).toEqual([]);
    void REASON_CONNECTION_LOST;
  });

  it('rejects a request on a closed handler with client_disconnected', async () => {
    const client = await connect({ clientId: 'pc-closed' });
    const handler = handlers[handlers.length - 1]!;
    handler.close();
    const error = await sendRequest('alpha', { method: 'tools/call' }).catch((e: unknown) => e);
    expect((error as { data?: { reason?: string } }).data?.reason).toBe('client_disconnected');
    void client;
  });
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

describe('subscribeNotifications', () => {
  it('routes notifications per server and stops after unsubscribe', async () => {
    const client = await connect({ clientId: 'pc-notif' });
    for (const name of ['alpha', 'beta']) {
      client.send({ type: 'server_up', server: name, info: info(name) });
      await client.expect('server_ack');
    }

    const alpha: { method: string; params?: unknown }[] = [];
    const beta: { method: string; params?: unknown }[] = [];
    const unsubscribe = subscribe('alpha', (n) => alpha.push(n));
    subscribe('beta', (n) => beta.push(n));

    client.send({ type: 'notification', server: 'alpha', method: 'notifications/tools/list_changed' });
    client.send({ type: 'notification', server: 'beta', method: 'notifications/message', params: { level: 'info' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(alpha).toEqual([{ method: 'notifications/tools/list_changed', params: undefined }]);
    expect(beta).toEqual([{ method: 'notifications/message', params: { level: 'info' } }]);

    unsubscribe();
    client.send({ type: 'notification', server: 'alpha', method: 'notifications/tools/list_changed' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(alpha.length).toBe(1);
    expect(beta.length).toBe(1);
  });
});

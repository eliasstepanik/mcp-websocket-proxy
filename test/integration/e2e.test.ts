/**
 * T2d proof: the **whole** chain, no mocks.
 *
 *   test (SDK `Client` + `StreamableHTTPClientTransport`)
 *     -> createApp(): node:http on 127.0.0.1:0
 *        - `POST/GET/DELETE /mcp/<name>` -> McpEndpointHandler -> TunnelUpstream
 *        - `upgrade /tunnel`             -> TunnelHandler <-> Registry
 *     -> TunnelClient (the "work PC")
 *        -> LocalMcpServer x2 (SDK `Client` + `StdioClientTransport`)
 *           -> test/fixtures/fake-mcp-server.mjs
 *
 * Everything below talks to the proxy exactly like Warren does: an MCP SDK client
 * over Streamable HTTP, plus one raw `fetch` for the cases the SDK hides (a 503
 * `initialize`, an explicit `DELETE`, reusing a session id across a tunnel outage).
 */

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

const CLIENT_ID = 'e2e-pc';
/** Two distinct tokens (>= 32 chars): the tunnel client and the MCP endpoints never share one. */
const CLIENT_TOKEN = 'e2e-client-token-aaaaaaaaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'e2e-endpoint-token-bbbbbbbbbbbbbbbbbbb';
/** The fixture's own tool list, before anything mutates it. */
const BASE_TOOLS = ['echo', 'slow', 'progress', 'mutate', 'crash'];

let app: App | undefined;
let baseUrl = '';
let tunnelUrl = '';
let client: TunnelClient | undefined;
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

/** Spawns the two fixture children and the tunnel client that exposes them. */
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
    url: tunnelUrl,
    token: CLIENT_TOKEN,
    clientId: CLIENT_ID,
    servers: locals,
  });
  await waitFor(
    () => app?.registry.lookup('alpha')?.up === true && app?.registry.lookup('beta')?.up === true,
    'both fixture servers to be registered',
  );
}

async function stopTunnel(): Promise<void> {
  client?.stop();
  client = undefined;
  for (const local of locals?.values() ?? []) await local.stop();
}

/** One Warren session on `/mcp/<name>`, with a copy of every inbound notification. */
async function connectServer(
  name: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport; notifications: string[] }> {
  const notifications: string[] = [];
  const warren = new Client({ name: 'warren-e2e', version: '1.0.0' });
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

/** One raw JSON-RPC request on an existing session (the body is read as text, never parsed). */
async function rawPost(name: string, sessionId: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}/mcp/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
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

beforeAll(async () => {
  app = createApp({});
  await new Promise<void>((resolve) => app!.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
  tunnelUrl = `ws://127.0.0.1:${address.port}/tunnel`;
});

afterAll(async () => {
  await app?.close();
  app = undefined;
});

beforeEach(async () => {
  await startTunnel();
});

afterEach(async () => {
  await stopTunnel();
});

// ---------------------------------------------------------------------------
// 1-3: handshake, per-server isolation, request relay
// ---------------------------------------------------------------------------

describe('e2e: Warren -> Warren endpoint -> tunnel -> fixture child', () => {
  it('answers initialize on both endpoints from each fixture child', async () => {
    const alpha = await connectServer('alpha');
    const beta = await connectServer('beta');

    for (const warren of [alpha.client, beta.client]) {
      expect(warren.getServerVersion()).toMatchObject({ name: 'fake-mcp-server', version: '1.2.3' });
      expect(warren.getInstructions()).toBe('Fixture server used by mcp-websocket-proxy tests.');
      expect(warren.getServerCapabilities()).toMatchObject({ tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} });
    }
    // The session ids are per endpoint: two names, two sessions.
    expect(alpha.transport.sessionId).toBeTruthy();
    expect(beta.transport.sessionId).toBeTruthy();
    expect(alpha.transport.sessionId).not.toBe(beta.transport.sessionId);

    await alpha.client.close();
    await beta.client.close();
  });

  it('lists only the tools of the server named in the route', async () => {
    const alpha = await connectServer('alpha');
    const beta = await connectServer('beta');

    expect((await alpha.client.listTools()).tools.map((t) => t.name)).toEqual(BASE_TOOLS);
    expect((await beta.client.listTools()).tools.map((t) => t.name)).toEqual(BASE_TOOLS);

    // Mutating alpha must not be visible through beta: the two routes are bound to
    // two different child processes, not to one shared upstream.
    const mutated = await alpha.client.callTool({ name: 'mutate', arguments: {} });
    expect(mutated.content).toEqual([{ type: 'text', text: 'mutate:added:extra_1' }]);
    await waitFor(
      async () => (await readFixtureState(alpha.client)).extraTools instanceof Array,
      'alpha to record the mutation',
      10_000,
    );

    expect((await alpha.client.listTools()).tools.map((t) => t.name)).toEqual([...BASE_TOOLS, 'extra_1']);
    expect((await beta.client.listTools()).tools.map((t) => t.name)).toEqual(BASE_TOOLS);

    await alpha.client.close();
    await beta.client.close();
  });

  it('relays a tools/call end to end', async () => {
    const alpha = await connectServer('alpha');
    const call = await alpha.client.callTool({ name: 'echo', arguments: { text: 'hello from warren' } });
    expect(call.content).toEqual([{ type: 'text', text: 'echo:hello from warren' }]);

    // An upstream error keeps its code and data across every hop.
    const error = (await alpha.client
      .callTool({ name: 'echo', arguments: { text: '__error__' } })
      .then(() => undefined)
      .catch((e: unknown) => e)) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(-32100);
    expect(error.message).toBe('MCP error -32100: fixture refuses to echo');
    expect(error.data).toEqual({ fixture: true });

    await alpha.client.close();
  });

  // -------------------------------------------------------------------------
  // 4: upstream notifications stay on their own server
  // -------------------------------------------------------------------------

  it('delivers notifications/tools/list_changed to the alpha session only', async () => {
    const alpha = await connectServer('alpha');
    const beta = await connectServer('beta');
    let alphaChanged = 0;
    let betaChanged = 0;
    alpha.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      alphaChanged += 1;
    });
    beta.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      betaChanged += 1;
    });
    // Let both standalone GET streams be established before anything is emitted.
    await alpha.client.listTools();
    await beta.client.listTools();

    await alpha.client.callTool({ name: 'mutate', arguments: {} });
    await waitFor(() => alphaChanged > 0, 'tools/list_changed on the alpha session', 15_000);

    // The beta session had every chance to receive it (same proxy, same tunnel,
    // already subscribed): beta's child never emitted the notification.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(betaChanged).toBe(0);
    expect(beta.notifications).not.toContain('notifications/tools/list_changed');

    await alpha.client.close();
    await beta.client.close();
  });

  // -------------------------------------------------------------------------
  // 5: progress
  // -------------------------------------------------------------------------

  it('relays progress notifications through the whole chain', async () => {
    const alpha = await connectServer('alpha');
    const progress: { progress: number; total?: number; message?: string }[] = [];
    const result = await alpha.client.callTool(
      { name: 'progress', arguments: { steps: 4 } },
      undefined,
      { onprogress: (p) => progress.push(p) },
    );

    expect(result.content).toEqual([{ type: 'text', text: 'progress:done:4' }]);
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3, 4]);
    expect(progress[0]).toMatchObject({ total: 4, message: 'step 1/4' });

    await alpha.client.close();
  });

  // -------------------------------------------------------------------------
  // 6: cancellation
  // -------------------------------------------------------------------------

  it('propagates a cancelled call to the fixture child', async () => {
    const alpha = await connectServer('alpha');
    const controller = new AbortController();
    const pending = alpha.client
      .callTool({ name: 'slow', arguments: { ms: 10_000 } }, undefined, { signal: controller.signal })
      .catch((e: unknown) => e);
    // Give the request time to reach the child before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort('user cancelled');
    await pending;

    await waitFor(
      async () => (await readFixtureState(alpha.client)).lastCancellation !== null,
      'the fixture to observe the cancellation',
      15_000,
    );
    const state = await readFixtureState(alpha.client);
    expect(String((state.lastCancellation as { reason?: string }).reason)).toContain('cancelled');

    await alpha.client.close();
  });
});

// ---------------------------------------------------------------------------
// 7: a name nobody serves
// ---------------------------------------------------------------------------

describe('e2e: an unregistered server name', () => {
  it('answers initialize on /mcp/gamma with 503 + -32050 offline + retry-after', async () => {
    const response = await rawInitialize('gamma');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');

    const body = (await response.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string; data?: { source?: string; reason?: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(PROXY_ERROR_CODE);
    expect(body.error.data).toEqual({ source: PROXY_ERROR_SOURCE, reason: 'offline' });
  });
});

// ---------------------------------------------------------------------------
// 8: concurrent sessions on one endpoint
// ---------------------------------------------------------------------------

describe('e2e: two sessions on /mcp/alpha', () => {
  it('serves both concurrently and keeps one alive when the other is deleted', async () => {
    const first = await connectServer('alpha');
    const second = await connectServer('alpha');
    expect(first.transport.sessionId).toBeTruthy();
    expect(second.transport.sessionId).toBeTruthy();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);

    // Both sessions work at the same time, and concurrently.
    const [a, b] = await Promise.all([
      first.client.callTool({ name: 'echo', arguments: { text: 'one' } }),
      second.client.callTool({ name: 'echo', arguments: { text: 'two' } }),
    ]);
    expect(a.content).toEqual([{ type: 'text', text: 'echo:one' }]);
    expect(b.content).toEqual([{ type: 'text', text: 'echo:two' }]);

    const firstSession = first.transport.sessionId!;
    // An explicit DELETE tears down exactly one session.
    await first.transport.terminateSession();
    await waitFor(
      async () => (await rawPost('alpha', firstSession, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status === 404,
      'the deleted session to answer 404',
      10_000,
    );

    const survivor = await second.client.callTool({ name: 'echo', arguments: { text: 'still here' } });
    expect(survivor.content).toEqual([{ type: 'text', text: 'echo:still here' }]);
    expect((await second.client.listTools()).tools.map((t) => t.name)).toEqual(BASE_TOOLS);

    await first.client.close();
    await second.client.close();
  });
});

// ---------------------------------------------------------------------------
// 9: the tunnel dies and comes back
// ---------------------------------------------------------------------------

describe('e2e: a dropped tunnel', () => {
  it('answers 503 while the client is gone and reuses the session after it reconnects', async () => {
    const alpha = await connectServer('alpha');
    const sessionId = alpha.transport.sessionId!;
    expect(sessionId).toBeTruthy();
    expect(await alpha.client.callTool({ name: 'echo', arguments: { text: 'before' } })).toEqual({
      content: [{ type: 'text', text: 'echo:before' }],
    });

    // Kill the tunnel: the name goes offline for *new* sessions...
    client?.stop();
    client = undefined;
    await waitFor(() => app?.registry.lookup('alpha') === undefined, 'alpha to leave the registry', 15_000);

    const offline = await rawInitialize('alpha');
    expect(offline.status).toBe(503);
    expect(offline.headers.get('retry-after')).toBe('10');
    const offlineBody = (await offline.json()) as { error: { code: number; data?: { reason?: string } } };
    expect(offlineBody.error.code).toBe(PROXY_ERROR_CODE);
    expect(offlineBody.error.data?.reason).toBe('offline');

    // ...but the Warren session survives the outage: the same client dials again with
    // the same `clientId` and the session id keeps working, no re-initialize needed.
    client = new TunnelClient({ url: tunnelUrl, token: CLIENT_TOKEN, clientId: CLIENT_ID, servers: locals });
    await waitFor(() => app?.registry.lookup('alpha')?.up === true, 'alpha to be registered again', 20_000);

    const reinitialized = await rawInitialize('alpha');
    expect(reinitialized.status).toBe(200);
    await reinitialized.body?.cancel();

    const echo = await rawPost('alpha', sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'after' } },
    });
    expect(echo.status).toBe(200);
    const text = await echo.text();
    expect(text).toContain('echo:after');

    // The live SDK session on the same id is still usable too.
    expect(await alpha.client.callTool({ name: 'echo', arguments: { text: 'same session' } })).toEqual({
      content: [{ type: 'text', text: 'echo:same session' }],
    });
    expect(alpha.transport.sessionId).toBe(sessionId);

    await alpha.client.close();
  });
});

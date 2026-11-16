/**
 * T1 proof: an MCP Streamable HTTP endpoint (server side) can serve a generic relay
 * to a local stdio MCP server (client side) using the MCP SDK on both ends, with no
 * WebSocket layer in between.
 *
 * Topology under test (all in-process, one child process):
 *
 *   test (SDK Client + StreamableHTTPClientTransport)
 *     -> node:http server -> createMcpEndpointHandler('/mcp/fake')
 *       -> LocalMcpServer (SDK Client + StdioClientTransport)
 *         -> test/fixtures/fake-mcp-server.mjs
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMcpEndpointHandler, type McpEndpointHandler } from '../../src/server/mcp-endpoint.js';
import { LocalMcpServer } from '../../src/client/local-server.js';
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE, proxyError } from '../../src/shared/errors.js';
import type { Upstream } from '../../src/shared/upstream.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

let httpServer: HttpServer;
let baseUrl: string;
let handler: McpEndpointHandler;
let local: LocalMcpServer;
let stderrLines: string[];
let stateChanges: string[];
let startLogFile: string;
let workDir: string;

async function startStack(): Promise<void> {
  stderrLines = [];
  stateChanges = [];
  startLogFile = join(workDir, `starts-${Date.now()}`);
  writeFileSync(startLogFile, '');

  local = new LocalMcpServer({
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    env: { ...process.env, FIXTURE_START_LOG: startLogFile },
    restartDelays: [50],
    requestTimeoutMs: 20_000,
    onStderrLine: (line) => stderrLines.push(line),
    onStateChange: (state) => stateChanges.push(state),
  });
  await local.start();

  handler = createMcpEndpointHandler({ name: 'fake', upstream: local });
  httpServer = createServer((req, res) => {
    void handler.handle(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}/mcp/fake`;
}

async function stopStack(): Promise<void> {
  await handler?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer?.closeAllConnections?.(),
  );
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await local?.stop();
}

/** Connects a Warren-like client to the endpoint. */
async function connectWarren(): Promise<{ client: Client; notifications: { method: string; params?: unknown }[] }> {
  const notifications: { method: string; params?: unknown }[] = [];
  const client = new Client({ name: 'warren-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  transport.onmessage = (message) => {
    const candidate = message as { method?: unknown };
    if (typeof candidate.method === 'string' && 'method' in message && !('id' in message)) {
      notifications.push({ method: candidate.method, params: (message as { params?: unknown }).params });
    }
  };
  await client.connect(transport);
  return { client, notifications };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Reads the fixture's own observable state through the proxied resource. */
async function readFixtureState(client: Client): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri: 'fixture://state' });
  const first = result.contents[0];
  if (!first || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('fixture://state did not return text');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mcpwp-t1-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await startStack();
});

afterEach(async () => {
  await stopStack();
});

describe('relay: Streamable HTTP endpoint -> local stdio server', () => {
  it('answers initialize from cached upstream info', async () => {
    const { client } = await connectWarren();
    expect(client.getServerVersion()).toMatchObject({ name: 'fake-mcp-server', version: '1.2.3' });
    expect(client.getInstructions()).toBe('Fixture server used by mcp-websocket-proxy tests.');
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true }, resources: {}, prompts: {}, logging: {} });
    await client.close();
  });

  it('relays tools, resources and prompts', async () => {
    const { client } = await connectWarren();

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['echo', 'slow', 'progress', 'mutate', 'crash']);

    const call = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(call.content).toEqual([{ type: 'text', text: 'echo:hello' }]);

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toEqual(['fixture://state']);

    const resource = await client.readResource({ uri: 'fixture://state' });
    expect(resource.contents[0]).toMatchObject({ uri: 'fixture://state', mimeType: 'application/json' });

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['greet']);

    const prompt = await client.getPrompt({ name: 'greet', arguments: { name: 'warren' } });
    expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'hello warren' } }]);

    await client.close();
  });

  it('relays ping', async () => {
    const { client } = await connectWarren();
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  it('forwards notifications/tools/list_changed after mutate', async () => {
    const { client, notifications } = await connectWarren();
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged += 1;
    });

    // Give the standalone GET SSE stream a moment to be established.
    await client.listTools();

    const mutated = await client.callTool({ name: 'mutate', arguments: {} });
    expect(mutated.content).toEqual([{ type: 'text', text: 'mutate:added:extra_1' }]);

    await waitFor(() => listChanged > 0, 10_000, 'tools/list_changed');
    expect(notifications.some((n) => n.method === 'notifications/tools/list_changed')).toBe(true);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('extra_1');
    await client.close();
  });

  it('relays progress notifications with the caller token', async () => {
    const { client } = await connectWarren();
    const progress: { progress: number; total?: number; message?: string }[] = [];
    const result = await client.callTool(
      { name: 'progress', arguments: { steps: 3 } },
      undefined,
      { onprogress: (p) => progress.push(p) },
    );

    expect(result.content).toEqual([{ type: 'text', text: 'progress:done:3' }]);
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress[0]).toMatchObject({ total: 3, message: 'step 1/3' });
    await client.close();
  });

  it('passes upstream JSON-RPC error codes through unchanged', async () => {
    const { client } = await connectWarren();
    const error = await client
      .callTool({ name: 'echo', arguments: { text: '__error__' } })
      .then(() => undefined)
      .catch((e: unknown) => e as McpError);

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(-32100);
    expect(error?.message).toBe('fixture refuses to echo');
    expect(error?.data).toEqual({ fixture: true });
    await client.close();
  });

  it('delivers logging/setLevel to the fixture', async () => {
    const { client } = await connectWarren();
    await client.setLoggingLevel('warning');
    const state = await readFixtureState(client);
    expect(state.loggingLevel).toBe('warning');
    await client.close();
  });

  it('propagates cancellation to the fixture', async () => {
    const { client } = await connectWarren();
    const controller = new AbortController();
    const pending = client
      .callTool({ name: 'slow', arguments: { ms: 5_000 } }, undefined, { signal: controller.signal })
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort('user cancelled');
    await pending;

    await waitFor(async () => (await readFixtureState(client)).lastCancellation !== null, 5_000, 'fixture to observe cancellation');
    const state = await readFixtureState(client);
    const cancellation = state.lastCancellation as { reason?: string } | null;
    expect(cancellation).not.toBeNull();
    expect(cancellation?.reason).toContain('user cancelled');
    await client.close();
  });

  it('restarts the child after a crash and keeps serving', async () => {
    const { client } = await connectWarren();
    const crashed = await client.callTool({ name: 'crash', arguments: {} });
    expect(crashed.content).toEqual([{ type: 'text', text: 'crash:bye' }]);

    await waitFor(() => local.currentState === 'running', 10_000, 'child restart');
    expect(stateChanges).toContain('backoff');
    expect(readFileSync(startLogFile, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('echo');
    const state = await readFixtureState(client);
    expect(state.startCount).toBe(1);
    await client.close();
  });

  it('prefixes child stderr with the server name', async () => {
    const { client } = await connectWarren();
    await client.listTools();
    await waitFor(() => stderrLines.length > 0, 5_000, 'stderr output');
    expect(stderrLines.every((line) => line.startsWith('[fake:pid='))).toBe(true);
    expect(stderrLines.some((line) => line.includes('fixture: started'))).toBe(true);
    await client.close();
  });

  it('fails in-flight requests with a proxy error when the child dies', async () => {
    const { client } = await connectWarren();
    const pending = client.callTool({ name: 'slow', arguments: { ms: 5_000 } }).catch((e: unknown) => e as McpError);
    await waitFor(() => local.currentState === 'running');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await local.stop();

    const error = (await pending) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(PROXY_ERROR_CODE);
    expect((error.data as { source?: string; reason?: string }).source).toBe(PROXY_ERROR_SOURCE);
    expect((error.data as { reason?: string }).reason).toBe('server_down');
    await client.close();
  });

  it('answers 406 for a POST without the required Accept header', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    });
    expect(response.status).toBe(406);
    expect(handler.sessionCount()).toBe(0);
  });

  it('rejects requests for an unknown session id', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
  });

  it('fails initialize with a -32050 proxy error when nothing is upstream', async () => {
    const offline: Upstream = {
      name: 'offline-server',
      get info() {
        throw proxyError('offline', 'the work PC is not connected');
      },
      available: false,
      request: async () => {
        throw proxyError('offline', 'the work PC is not connected');
      },
      notification: async () => undefined,
      subscribe: () => () => undefined,
    };
    const offlineHandler = createMcpEndpointHandler({ name: 'offline-server', upstream: offline });
    const server = createServer((req, res) => void offlineHandler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('failed to bind');

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp/offline-server`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: number; data: { source: string; reason: string } } };
      expect(body.error.code).toBe(PROXY_ERROR_CODE);
      expect(body.error.data.source).toBe(PROXY_ERROR_SOURCE);
      expect(body.error.data.reason).toBe('offline');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

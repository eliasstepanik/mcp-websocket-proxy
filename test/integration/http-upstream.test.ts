/**
 * `url:` servers: `LocalMcpServer` connects to an MCP server that is already
 * listening on Streamable HTTP (e.g. a browser-extension bridge on
 * `127.0.0.1:<port>/mcp`) instead of spawning a child, relays requests, sends
 * configured headers, and reconnects when the endpoint comes up late.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { LocalMcpServer } from '../../src/client/local-server.js';

const servers: Server[] = [];
const upstreams: LocalMcpServer[] = [];

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) await upstream.stop();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A stateless Streamable HTTP MCP server with one `echo` tool; records request headers. */
async function startHttpMcp(port = 0): Promise<{ url: string; port: number; headers: IncomingMessage['headers'][] }> {
  const headers: IncomingMessage['headers'][] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    headers.push(req.headers);
    const mcp = new McpServer({ name: 'http-fixture', version: '1.0.0' });
    mcp.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await mcp.connect(transport);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    await transport.handleRequest(req, res, body);
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  const actual = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${actual}/mcp`, port: actual, headers };
}

describe('LocalMcpServer over Streamable HTTP', () => {
  it('initialises, relays tools/call and sends configured headers', async () => {
    const fixture = await startHttpMcp();
    const upstream = new LocalMcpServer({ name: 'chrome', url: fixture.url, headers: { 'X-Test': 'yes' } });
    upstreams.push(upstream);
    await upstream.start();

    expect(upstream.available).toBe(true);
    expect(upstream.pid).toBeNull();
    expect(upstream.info.serverInfo.name).toBe('http-fixture');
    const result = (await upstream.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toBe('hi');
    expect(fixture.headers.some((h) => h['x-test'] === 'yes')).toBe(true);
  });

  it('retries with backoff until the endpoint comes up', async () => {
    // Reserve a free port, then release it so the first connect is refused.
    const probe = await startHttpMcp();
    const port = probe.port;
    await new Promise((resolve) => servers.pop()!.close(resolve));

    const upstream = new LocalMcpServer({ name: 'late', url: `http://127.0.0.1:${port}/mcp`, restartDelays: [50] });
    upstreams.push(upstream);
    await expect(upstream.start()).rejects.toThrow(/failed to start/);
    expect(upstream.currentState).toBe('backoff');

    await startHttpMcp(port);
    const deadline = Date.now() + 10_000;
    while (!upstream.available && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(upstream.available).toBe(true);
  });
});

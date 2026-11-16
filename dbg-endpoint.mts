import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpEndpointHandler } from './src/server/mcp-endpoint.ts';
import { LocalMcpServer } from './src/client/local-server.ts';

const FIXTURE = new URL('./test/fixtures/fake-mcp-server.mjs', import.meta.url).pathname;
const local = new LocalMcpServer({ name: 'fake', command: process.execPath, args: [FIXTURE], env: process.env, restart: false });
await local.start();
console.log('info:', JSON.stringify(local.info));
const handler = createMcpEndpointHandler({ name: 'fake', upstream: local });
const httpServer = createServer((req, res) => void handler.handle(req, res));
await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
const addr = httpServer.address();
if (addr === null || typeof addr === 'string') throw new Error('nope');
const url = new URL(`http://127.0.0.1:${addr.port}/mcp/fake`);
const raw = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
});
console.log('status', raw.status);
console.log('body', await raw.text());
await local.stop();
httpServer.close();
process.exit(0);

import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// Server whose fallback handler throws an error carrying code/message/data verbatim.
const server = new Server({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
server.fallbackRequestHandler = async () => {
  const err = new Error('fixture refuses to echo') as Error & { code: number; data: unknown };
  err.code = -32100;
  err.data = { fixture: true };
  throw err;
};
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'sess-1' });
await server.connect(transport);

const http = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => void transport.handleRequest(req, res, JSON.parse(body || '{}')));
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const addr = http.address();
if (addr === null || typeof addr === 'string') throw new Error('bind');
const url = new URL(`http://127.0.0.1:${addr.port}/mcp`);

const client = new Client({ name: 'warren', version: '1' });
await client.connect(new StreamableHTTPClientTransport(url));
try {
  const r = await client.request({ method: 'tools/call', params: { name: 'echo' } });
  console.log('result', r);
} catch (e) {
  const err = e as McpError;
  console.log('instanceof McpError:', err instanceof McpError);
  console.log('code:', err.code);
  console.log('message:', JSON.stringify(err.message));
  console.log('data:', JSON.stringify(err.data));
}
await client.close();
await server.close();
http.close();
process.exit(0);

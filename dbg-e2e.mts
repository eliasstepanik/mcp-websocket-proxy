// Scratch smoke: does notifications/tools/list_changed travel the full chain?
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { createApp } from './src/server/app.js';
import { LocalMcpServer } from './src/client/local-server.js';
import { TunnelClient } from './src/client/tunnel-client.js';

const FIXTURE = new URL('./test/fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

const app = createApp({});
await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
const port = (app.httpServer.address() as { port: number }).port;
const wsUrl = `ws://127.0.0.1:${port}/tunnel`;
const base = `http://127.0.0.1:${port}`;

const servers = new Map<string, LocalMcpServer>();
for (const name of ['alpha', 'beta']) {
  const local = new LocalMcpServer({ name, command: process.execPath, args: [FIXTURE], restart: false, onStderrLine: () => undefined });
  await local.start();
  servers.set(name, local);
}
const client = new TunnelClient({ url: wsUrl, token: 'test-token', clientId: 'e2e-pc', servers });
await new Promise((r) => setTimeout(r, 500));
console.log('registry', app.registry.listServers().map((s) => `${s.name}:${s.up}`));

async function connect(name: string) {
  const c = new Client({ name: 'warren', version: '1' });
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${name}`));
  await c.connect(t);
  return { c, t };
}

const a = await connect('alpha');
const b = await connect('beta');
let aCount = 0;
let bCount = 0;
a.c.setNotificationHandler(ToolListChangedNotificationSchema, () => (aCount += 1));
b.c.setNotificationHandler(ToolListChangedNotificationSchema, () => (bCount += 1));
await new Promise((r) => setTimeout(r, 300));
console.log('alpha tools', (await a.c.listTools()).tools.map((t) => t.name));
console.log('mutate', JSON.stringify(await a.c.callTool({ name: 'mutate', arguments: {} })));
await new Promise((r) => setTimeout(r, 1000));
console.log('listChanged alpha/beta', aCount, bCount);
console.log('alpha tools after', (await a.c.listTools()).tools.map((t) => t.name));
console.log('beta tools after', (await b.c.listTools()).tools.map((t) => t.name));

// cancellation
const ctrl = new AbortController();
const pending = a.c.callTool({ name: 'slow', arguments: { ms: 5000 } }, undefined, { signal: ctrl.signal }).catch((e) => e);
await new Promise((r) => setTimeout(r, 400));
ctrl.abort('user cancelled');
console.log('slow result', await pending);
await new Promise((r) => setTimeout(r, 300));
const st = await a.c.readResource({ uri: 'fixture://state' });
console.log('state', JSON.stringify(st.contents[0]));

// session survival across a tunnel kill
const sid = a.t.sessionId;
console.log('session id', sid);
client.stop();
await new Promise((r) => setTimeout(r, 300));
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
const off = await fetch(`${base}/mcp/alpha`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) });
console.log('offline status', off.status, off.headers.get('retry-after'), (await off.text()).slice(0, 160));
const client2 = new TunnelClient({ url: wsUrl, token: 'test-token', clientId: 'e2e-pc', servers });
await new Promise((r) => setTimeout(r, 500));
console.log('after reconnect echo', JSON.stringify(await a.c.callTool({ name: 'echo', arguments: { text: 'again' } })), 'sid still', a.t.sessionId === sid);

await a.c.close();
await b.c.close();
client2.stop();
for (const l of servers.values()) await l.stop();
await app.close();
console.log('done');

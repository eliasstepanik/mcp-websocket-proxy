import { createApp } from './src/server/app.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';

const app = createApp({});
await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
const port = (app.httpServer.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
await once(ws, 'open');
const frames: any[] = [];
ws.on('message', (d: Buffer) => {
  const f = JSON.parse(d.toString());
  frames.push(f);
  if (f.type === 'request') {
    if (f.method === 'tools/list') ws.send(JSON.stringify({ type: 'response', id: f.id, result: { tools: [{ name: 'x' }] } }));
    else ws.send(JSON.stringify({ type: 'response', id: f.id, result: {} }));
  }
});
ws.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'c1' }));
ws.send(
  JSON.stringify({
    type: 'server_up',
    server: 'demo',
    info: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } },
  }),
);
await new Promise((r) => setTimeout(r, 100));

const init = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
};
const r1 = await fetch(`${base}/mcp/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(init),
});
const sid = r1.headers.get('mcp-session-id')!;
await r1.text();

const r2 = await fetch(`${base}/mcp/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
});
console.log('tools/list', r2.status, (await r2.text()).replace(/\r\n/g, '|').slice(0, 220));

// notification Warren -> upstream (notifications/cancelled)
await fetch(`${base}/mcp/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '99', reason: 'gone' } }),
});
await new Promise((r) => setTimeout(r, 150));
console.log('tunnel saw', JSON.stringify(frames.filter((f) => f.type === 'request' || f.type === 'notification')));

// upstream-originated notification -> SSE on the standalone GET stream
const getS = await fetch(`${base}/mcp/demo`, {
  headers: { accept: 'text/event-stream', 'mcp-session-id': sid },
});
console.log('GET stream', getS.status);
await new Promise((r) => setTimeout(r, 50));
ws.send(JSON.stringify({ type: 'notification', server: 'demo', method: 'notifications/tools/list_changed' }));
const reader = getS.body!.getReader();
const { value } = await reader.read();
console.log('sse', new TextDecoder().decode(value).replace(/\r\n/g, '|').slice(0, 200));

await app.close();
console.log('closed ok');
process.exit(0);

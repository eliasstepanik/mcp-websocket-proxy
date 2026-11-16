import { createApp } from './src/server/app.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';

const app = createApp({});
await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
const port = (app.httpServer.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const info = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } };

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  await once(ws, 'open');
  const frames: any[] = [];
  (ws as any).frames = frames;
  ws.on('message', (d: Buffer) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    if (f.type === 'request') ws.send(JSON.stringify({ type: 'response', id: f.id, result: { tools: [{ name: 'from-new' }] } }));
  });
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'c1' }));
  await new Promise((r) => setTimeout(r, 60));
  ws.send(JSON.stringify({ type: 'server_up', server: 'demo', info }));
  await new Promise((r) => setTimeout(r, 60));
  return ws;
}

async function call(): Promise<string> {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
  const r1 = await fetch(`${base}/mcp/demo`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) });
  const sid = r1.headers.get('mcp-session-id')!;
  await r1.text();
  const r2 = await fetch(`${base}/mcp/demo`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  return (await r2.text()).replace(/\s+/g, ' ');
}

const ws1 = await connect();
console.log('first call:', await call());

// reconnect with the same clientId: the old socket is replaced (4002)
const ws2 = await connect();
await new Promise((r) => setTimeout(r, 200));
console.log('old socket replaced:', ws1.readyState === 3 || ws1.readyState === 2);
console.log('call after reconnect:', await call());

// now kill the NEW socket: names go offline
ws2.close();
await new Promise((r) => setTimeout(r, 150));
const r3 = await fetch(`${base}/mcp/demo`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }) });
console.log('after kill (expect 503):', r3.status, (await r3.text()).slice(0, 120));

await app.close();
console.log('closed ok');
process.exit(0);

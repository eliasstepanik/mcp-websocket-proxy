import { createApp } from './src/server/app.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';

const app = createApp({ serverVersion: 'smoke', sessionIdleTtlMs: 60_000 });
await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
const port = (app.httpServer.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// healthz
const h = await fetch(`${base}/healthz`);
console.log('healthz', h.status, await h.text());

// unknown route
const u = await fetch(`${base}/nope`);
console.log('unknown', u.status, await u.text());

// mcp route, nothing upstream -> 503 offline on initialize
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
};
const m = await fetch(`${base}/mcp/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(init),
});
console.log('mcp offline', m.status, m.headers.get('retry-after'), (await m.text()).slice(0, 200));

// bad name
const bad = await fetch(`${base}/mcp/BAD NAME`, { method: 'POST', body: '{}' });
console.log('bad name', bad.status, (await bad.text()).slice(0, 120));

// tunnel upgrade + hello + server_up
const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
await once(ws, 'open');
const frames: any[] = [];
ws.on('message', (d: Buffer) => frames.push(JSON.parse(d.toString())));
ws.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'c1' }));
await new Promise((r) => setTimeout(r, 100));
console.log('welcome', JSON.stringify(frames[0]));
ws.send(
  JSON.stringify({
    type: 'server_up',
    server: 'demo',
    info: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } },
  }),
);
await new Promise((r) => setTimeout(r, 100));
console.log('ack', JSON.stringify(frames[1]), 'registry servers', app.registry.serverCount);

// now initialize should create a session and the tunnel should get a request frame
const m2 = await fetch(`${base}/mcp/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(init),
});
console.log('mcp init', m2.status, 'session', m2.headers.get('mcp-session-id'));
await new Promise((r) => setTimeout(r, 100));
console.log('tunnel frames', JSON.stringify(frames.slice(2)));

// wrong upgrade path
const badWs = new WebSocket(`ws://127.0.0.1:${port}/other`);
badWs.on('error', (e: Error) => console.log('bad upgrade errored:', e.message));
badWs.on('unexpected-response', (_req, res) => console.log('bad upgrade status', res.statusCode));
await new Promise((r) => setTimeout(r, 200));

ws.close();
await new Promise((r) => setTimeout(r, 100));
console.log('after close, registry', app.registry.serverCount);
await app.close();
console.log('closed ok');
process.exit(0);

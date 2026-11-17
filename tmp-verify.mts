/** Temporary verification script (deleted after the run). */
import { createServer } from 'node:http';
import { connect } from 'node:net';

import { createApp } from './src/server/app.js';
import { TunnelClient } from './src/client/tunnel-client.js';
import { Registry } from './src/server/registry.js';

// ---- 1. registry: replaced connection marks inherited names down -------------
{
  const registry = new Registry();
  const events: unknown[] = [];
  registry.on((e) => events.push(e));
  const ws = (label: string) => ({ readyState: 1, send: () => {}, close: () => {} , label});
  registry.registerConnection('pc', ws('a') as never);
  registry.markServerUp('pc', 'files', { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'files', version: '1' } });
  events.length = 0;
  const { replaced } = registry.registerConnection('pc', ws('b') as never);
  console.log('1 replaced:', (replaced?.ws as { label: string }).label, 'owned:', [...(registry.get('pc')!.servers)]);
  console.log('1 lookup up:', registry.lookup('files')?.up, 'events:', JSON.stringify(events));
}

// ---- 2. heartbeatTimeoutMs terminates a silent socket ------------------------
{
  const app = createApp({
    clientToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    endpointToken: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 250,
  });
  await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
  const port = (app.httpServer.address() as { port: number }).port;

  // A stalling proxy so neither side sees a FIN.
  const open = new Set<import('node:net').Socket>();
  const proxy = createServer((clientSocket) => {
    const up = connect({ host: '127.0.0.1', port });
    open.add(clientSocket);
    open.add(up);
    clientSocket.pipe(up);
    up.pipe(clientSocket);
    clientSocket.on('error', () => {});
    up.on('error', () => {});
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = (proxy.address() as { port: number }).port;

  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/tunnel`, { headers: { authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  await new Promise<void>((r) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'slow' })); r(); }));
  await new Promise<void>((r) => setTimeout(r, 60));
  for (const s of open) s.pause();
  const started = Date.now();
  while (app.registry.connectionCount > 0 && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log('2 dropped after', Date.now() - started, 'ms (expect ~350 = interval + timeout); connections =', app.registry.connectionCount);
  ws.terminate();
  for (const s of open) s.destroy();
  await new Promise<void>((r) => proxy.close(() => r()));
  await app.close();
}

// ---- 3. malformed percent escape in /mcp/<name> ------------------------------
{
  const app = createApp({ clientToken: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', endpointToken: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  await new Promise<void>((r) => app.httpServer.listen(0, '127.0.0.1', r));
  const port = (app.httpServer.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/mcp/%E0`, {
    method: 'POST',
    headers: { authorization: 'Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  console.log('3 status', res.status, JSON.stringify(await res.json()));
  await app.close();
}

// ---- 4. a 401 upgrade answer: one log line, long retry -----------------------
{
  let dials = 0;
  const server = createServer((req, res) => {
    dials += 1;
    res.writeHead(401, { 'www-authenticate': 'Bearer' });
    res.end('Unauthorized: token\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const client = new TunnelClient({
    url: `ws://127.0.0.1:${port}/tunnel`,
    token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    clientId: 'nope',
    servers: new Map(),
  });
  await new Promise<void>((r) => setTimeout(r, 1200));
  console.log('4 state', client.state, 'dials in 1.2s =', dials, '(expect 1: the retry waits the 60s auth delay)');
  client.stop();
  await new Promise<void>((r) => server.close(() => r()));
}
process.exit(0);

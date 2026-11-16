import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { TunnelHandler } from './src/server/tunnel.ts';
import { Registry } from './src/server/registry.ts';

const registry = new Registry();
const httpServer = createServer();
const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket as never, head, (ws: WebSocket) => {
    new TunnelHandler(ws, registry, { serverVersion: 'dbg' });
  });
});
await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
const port = (httpServer.address() as { port: number }).port;
const url = `ws://127.0.0.1:${port}/tunnel`;

const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'dbg' }));
});
ws.on('message', (d: Buffer) => {
  console.log('msg:', d.toString());
  ws.send('{not json');
});
ws.on('close', (code, reason) => console.log('client close', code, reason.toString()));
ws.on('error', (e) => console.log('client error', e.message));
setTimeout(() => {
  console.log('done waiting');
  process.exit(0);
}, 1500);

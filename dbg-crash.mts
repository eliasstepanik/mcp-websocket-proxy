import { LocalMcpServer } from './src/client/local-server.ts';

const FIXTURE = new URL('./test/fixtures/fake-mcp-server.mjs', import.meta.url).pathname;
const states: string[] = [];
const local = new LocalMcpServer({
  name: 'fake',
  command: process.execPath,
  args: [FIXTURE],
  env: process.env,
  restartDelays: [50],
  onStateChange: (s) => {
    states.push(`${s}@${Date.now() % 100000}`);
    console.log('state ->', s);
  },
});
await local.start();
const t0 = Date.now();
const r = await local.request('tools/call', { name: 'crash', arguments: {} });
console.log('crash result', JSON.stringify(r), 'at +' + (Date.now() - t0) + 'ms');
console.log('state right after crash call:', local.currentState);
await new Promise((r2) => setTimeout(r2, 1500));
console.log('states:', states.join(','));
await local.stop();
process.exit(0);

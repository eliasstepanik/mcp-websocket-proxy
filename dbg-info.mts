import { LocalMcpServer } from './src/client/local-server.ts';
const FIXTURE = new URL('./test/fixtures/fake-mcp-server.mjs', import.meta.url).pathname;
const local = new LocalMcpServer({ name: 'fake', command: process.execPath, args: [FIXTURE], env: process.env, restart: false });
await local.start();
console.log(JSON.stringify(local.info, null, 2));
await local.stop();

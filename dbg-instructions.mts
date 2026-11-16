import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Where does `instructions` end up in the initialize result when passed as server-info vs options?
const a = new Server({ name: 'n', version: '1', instructions: 'top-level' }, { capabilities: {} });
const b = new Server({ name: 'n', version: '1' }, { capabilities: {}, instructions: 'options' });
const grab = (s: Server) => ({
  serverInfo: (s as unknown as { _serverInfo: unknown })._serverInfo,
  _instructions: (s as unknown as { _instructions?: unknown })._instructions,
});
console.log('server-info variant:', JSON.stringify(grab(a)));
console.log('options variant    :', JSON.stringify(grab(b)));

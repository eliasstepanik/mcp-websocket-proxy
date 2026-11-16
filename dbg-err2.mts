import { McpError } from '@modelcontextprotocol/sdk/types.js';
const e = new McpError(-32100, 'fixture refuses to echo', { fixture: true });
console.log('message:', JSON.stringify(e.message));
console.log('code:', e.code, 'data:', JSON.stringify(e.data));

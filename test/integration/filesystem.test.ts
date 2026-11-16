/**
 * T6 proof for the built-in filesystem server: a temp directory reaches a Warren
 * session through the whole chain.
 *
 *   temp dir + config.yaml -> loadClientConfig -> startClientApp
 *     -> createFilesystemServer (real `@modelcontextprotocol/server-filesystem`
 *        child, started with process.execPath)
 *     -> TunnelClient -> createApp() on 127.0.0.1:0 -> `/mcp/filesystem`
 *
 * What has to hold:
 * - listing and reading inside the root work;
 * - a path outside the root comes back as a tool **error result** (the child
 *   refuses it itself), not a crash and not a proxy error;
 * - with `filesystem.enabled: false` the name is not registered at all, so
 *   `/mcp/filesystem` answers 503 like any offline server;
 * - enabling it without roots is a config error (checked at the config layer,
 *   which is where the rule lives);
 * - plan D6: the client does not declare the `roots` capability, so the child
 *   keeps the command-line roots — the child says so on stderr, and the log file
 *   carries that line.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp, type App } from '../../src/server/app.js';
import { bearerHeader } from '../../src/server/auth.js';
import { loadClientConfig, checkConfigText } from '../../src/client/config.js';
import { startClientApp, type ClientApp } from '../../src/client/app.js';
import { FILESYSTEM_SERVER_PACKAGE, filesystemServerPath } from '../../src/client/filesystem.js';

const CLIENT_TOKEN = 'filesystem-client-token-aaaaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'filesystem-endpoint-token-bbbbbbbbbbbbbb';
const TOKEN_ENV = 'FILESYSTEM_TEST_TOKEN';

/** Text of the file the tests let the server read. */
const FILE_TEXT = 'hello from the filesystem server\n';

let app: App | undefined;
let baseUrl = '';
let tunnelUrl = '';
/** The root under test: a real temp dir, symlinks resolved (macOS `/tmp`). */
let root = '';
let dir = '';
let counter = 0;
let running: ClientApp | undefined;

const testEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [TOKEN_ENV]: CLIENT_TOKEN });

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Writes `text` to a fresh config file in the temp dir and returns its path. */
function writeConfig(text: string): string {
  counter += 1;
  const path = join(dir, `config-${counter}.yaml`);
  writeFileSync(path, text, 'utf8');
  return path;
}

/**
 * A config that exposes the built-in filesystem server over `roots` (plus one
 * fixture server, so a test that disables the filesystem server still exposes
 * something and passes the "at least one server" rule).
 */
function configYaml(options: { filesystem: string; logFile?: string }): string {
  const log =
    options.logFile === undefined ? 'log: { level: debug }' : `log:\n  level: debug\n  file: ${JSON.stringify(options.logFile)}`;
  return [
    'server:',
    `  url: ${tunnelUrl}`,
    `  token: \${env:${TOKEN_ENV}}`,
    'clientId: filesystem-test',
    log,
    options.filesystem,
    'servers:',
    `  fixture:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(
      new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname,
    )}]\n`,
    '',
  ].join('\n');
}

/** `/status` as the endpoint sees it. */
async function fetchStatus(): Promise<{ clients: { clientId: string; servers: { name: string; up: boolean }[] }[] }> {
  const response = await fetch(`${baseUrl}/status`, { headers: { authorization: bearerHeader(ENDPOINT_TOKEN) } });
  if (!response.ok) throw new Error(`/status answered ${response.status}`);
  return (await response.json()) as { clients: { clientId: string; servers: { name: string; up: boolean }[] }[] };
}

/** True when `/status` reports `name` as up. */
async function isUp(name: string): Promise<boolean> {
  const status = await fetchStatus();
  return status.clients.some((client) => client.servers.some((server) => server.name === name && server.up));
}

/** Starts an agent with `filesystemBlock` as its `filesystem:` section. */
async function startAgent(filesystemBlock: string, options: { logFile?: string } = {}): Promise<ClientApp> {
  const path = writeConfig(configYaml({ filesystem: filesystemBlock, ...options }));
  const agent = await startClientApp(loadClientConfig(path, testEnv()));
  running = agent;
  await waitFor(() => agent.tunnel.state === 'connected', 'the tunnel to connect');
  return agent;
}

/** One Warren session on `/mcp/<name>`. */
async function connectServer(name: string): Promise<Client> {
  const warren = new Client({ name: 'filesystem-warren', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${name}`), {
    requestInit: { headers: { authorization: bearerHeader(ENDPOINT_TOKEN) } },
  });
  await warren.connect(transport);
  return warren;
}

/** A bare `initialize` POST, for the case the SDK client cannot reach (a 503). */
async function rawInitialize(name: string): Promise<Response> {
  return await fetch(`${baseUrl}/mcp/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: bearerHeader(ENDPOINT_TOKEN),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'filesystem-raw', version: '1.0.0' } },
    }),
  });
}

/** The `text` of the first content block of a tool result. */
function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const block = content?.find((item) => item.type === 'text');
  return block?.text ?? '';
}

beforeAll(async () => {
  app = createApp({ clientToken: CLIENT_TOKEN, endpointToken: ENDPOINT_TOKEN });
  await new Promise<void>((resolve) => app!.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
  tunnelUrl = `ws://127.0.0.1:${address.port}/tunnel`;
});

afterAll(async () => {
  await app?.close();
  app = undefined;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fs-client-'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-root-')));
  writeFileSync(join(root, 'hello.txt'), FILE_TEXT, 'utf8');
  counter = 0;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('filesystemServerPath', () => {
  it('resolves the bundled package entry point without npx', () => {
    const entry = filesystemServerPath();
    expect(existsSync(entry)).toBe(true);
    // Resolved out of the package's own `bin` field, next to this repo.
    expect(entry).toContain(FILESYSTEM_SERVER_PACKAGE.replace('@', ''));
    expect(entry.endsWith('.js')).toBe(true);
  });
});

describe('built-in filesystem server through the tunnel', () => {
  it('lists and reads inside the root, and refuses a path outside it', async () => {
    const logFile = join(dir, 'agent.log');
    const agent = await startAgent(`filesystem:\n  enabled: true\n  name: filesystem\n  roots: [${JSON.stringify(root)}]`, {
      logFile,
    });
    expect(agent.servers.has('filesystem')).toBe(true);
    await waitFor(async () => await isUp('filesystem'), 'the filesystem server to be up');

    const warren = await connectServer('filesystem');
    expect((await warren.listTools()).tools.map((tool) => tool.name)).toContain('list_directory');

    const listed = await warren.callTool({ name: 'list_directory', arguments: { path: root } });
    expect((listed as { isError?: boolean }).isError).toBeFalsy();
    expect(firstText(listed)).toContain('[FILE] hello.txt');

    const read = await warren.callTool({ name: 'read_text_file', arguments: { path: join(root, 'hello.txt') } });
    expect((read as { isError?: boolean }).isError).toBeFalsy();
    expect(firstText(read)).toBe(FILE_TEXT);

    // Outside the root: the child refuses with an error *result* — the tunnel,
    // the endpoint and the child all stay alive.
    const escaped = await warren.callTool({
      name: 'read_text_file',
      arguments: { path: join(root, '..', '..', 'etc', 'passwd') },
    });
    expect((escaped as { isError?: boolean }).isError).toBe(true);
    expect(firstText(escaped)).toContain('Access denied');

    // A relative traversal is refused the same way.
    const relative = await warren.callTool({ name: 'read_text_file', arguments: { path: '../../../etc/passwd' } });
    expect((relative as { isError?: boolean }).isError).toBe(true);

    // The agent survived all of it and still answers.
    expect(agent.servers.get('filesystem')?.available).toBe(true);
    expect(firstText(await warren.callTool({ name: 'read_text_file', arguments: { path: join(root, 'hello.txt') } }))).toBe(FILE_TEXT);
    await warren.close();

    // D6: the client declares no `roots` capability, so the child keeps the
    // command-line directories — it logs exactly that on stderr, and the log
    // file carries the line.
    await waitFor(() => readFileSync(logFile, 'utf8').includes('does not support MCP Roots'), 'the roots-capability stderr line');
  });

  it('answers 503 on /mcp/filesystem when the filesystem server is disabled', async () => {
    const agent = await startAgent('filesystem: { enabled: false }');
    expect(agent.servers.has('filesystem')).toBe(false);
    expect(agent.servers.has('fixture')).toBe(true);

    const response = await rawInitialize('filesystem');
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: number; data?: { reason?: string } } };
    expect(body.error.data?.reason).toBe('offline');
  });
});

describe('filesystem config rules', () => {
  it('accepts the documented example file (config.example.yaml)', () => {
    const example = new URL('../../config.example.yaml', import.meta.url);
    const check = checkConfigText(readFileSync(example, 'utf8'), {
      ...testEnv(),
      DATABASE_URL: 'postgres://me:secret@db.internal/app',
    });
    expect(check.errors).toEqual([]);
    expect(check.config?.filesystem.enabled).toBe(true);
    expect([...check.config?.servers.keys() ?? []]).toEqual(['time', 'postgres']);
  });

  it('rejects an enabled filesystem server with no roots', () => {
    const check = checkConfigText(
      `server:\n  url: wss://warren.example.com/tunnel\n  token: \${env:${TOKEN_ENV}}\nfilesystem: { enabled: true }\n`,
      testEnv(),
    );
    expect(check.ok).toBe(false);
    expect(check.errors).toContain('filesystem.roots is required when the filesystem server is enabled');
  });

  it('accepts an empty roots list when the server is disabled', () => {
    const check = checkConfigText(
      `server:\n  url: wss://warren.example.com/tunnel\n  token: \${env:${TOKEN_ENV}}\nfilesystem: { enabled: false }\nservers:\n  fixture: { command: node }\n`,
      testEnv(),
    );
    expect(check.errors).toEqual([]);
    expect(check.config?.filesystem).toEqual({ enabled: false, name: 'filesystem', roots: [] });
  });
});

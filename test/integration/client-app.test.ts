/**
 * T6 proof: {@link startClientApp} turns a YAML config file into a running work-PC
 * agent, end to end and with real child processes.
 *
 * Topology under test (the server half is the real one, see `test/integration/e2e.test.ts`):
 *
 *   temp config.yaml -> loadClientConfig -> startClientApp
 *     -> LocalMcpServer x2 -> test/fixtures/fake-mcp-server.mjs
 *     -> TunnelClient -> createApp() on 127.0.0.1:0
 *          - `GET  /status`        (endpoint token)
 *          - `POST /mcp/<name>`    (endpoint token)
 *
 * The CLI (`--check`) is exercised as a real subprocess, because "validate the file
 * and exit without connecting" is a property of the process, not of a function.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp, type App } from '../../src/server/app.js';
import { bearerHeader } from '../../src/server/auth.js';
import { loadClientConfig } from '../../src/client/config.js';
import { startClientApp, type ClientApp } from '../../src/client/app.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;
/** Absolute path of the repo root: the CLI subprocess must run from it. */
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

const CLIENT_TOKEN = 'client-app-client-token-aaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'client-app-endpoint-token-bbbbbbbbbbbbbb';
/** The env var the config file expands into the tunnel token. */
const TOKEN_ENV = 'CLIENT_APP_TEST_TOKEN';
/** A variable that is deliberately never set, for the `--check` failure case. */
const MISSING_ENV = 'CLIENT_APP_TEST_DEFINITELY_NOT_SET';

let app: App | undefined;
let baseUrl = '';
let tunnelUrl = '';
let dir = '';
let counter = 0;
let running: ClientApp | undefined;

const testEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [TOKEN_ENV]: CLIENT_TOKEN });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Writes `text` to a fresh file in the temp dir and returns its path. */
function writeConfig(text: string): string {
  counter += 1;
  const path = join(dir, `config-${counter}.yaml`);
  writeFileSync(path, text, 'utf8');
  return path;
}

/** One `servers:` entry running the fixture under this Node binary. */
function fixtureEntry(name: string): string {
  return `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(FIXTURE)}]\n`;
}

/** The whole config document: `serversBlock` is the indented `servers:` mapping. */
function configYaml(serversBlock: string, options: { logFile?: string } = {}): string {
  const log =
    options.logFile === undefined ? 'log: { level: debug }' : `log:\n  level: debug\n  file: ${JSON.stringify(options.logFile)}`;
  return [
    'server:',
    `  url: ${tunnelUrl}`,
    `  token: \${env:${TOKEN_ENV}}`,
    'clientId: client-app-test',
    log,
    // The filesystem server is not what these tests are about: it is disabled so
    // the assertions on `/status` see exactly the servers the config names.
    'filesystem: { enabled: false }',
    'servers:',
    serversBlock,
    '',
  ].join('\n');
}

/** `/status` as the endpoint sees it. */
async function fetchStatus(): Promise<{ clients: { clientId: string; servers: { name: string; up: boolean }[] }[] }> {
  const response = await fetch(`${baseUrl}/status`, { headers: { authorization: bearerHeader(ENDPOINT_TOKEN) } });
  if (!response.ok) throw new Error(`/status answered ${response.status}`);
  return (await response.json()) as { clients: { clientId: string; servers: { name: string; up: boolean }[] }[] };
}

/** One Warren session on `/mcp/<name>`. */
async function connectServer(name: string): Promise<Client> {
  const warren = new Client({ name: 'client-app-warren', version: '1.0.0' });
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
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'client-app-raw', version: '1.0.0' } },
    }),
  });
}

/** True when `pid` is still a live process (`kill(pid, 0)` throws ESRCH otherwise). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs the CLI as a subprocess and returns its exit code and output. */
function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', 'src/client/main.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Runs the client as a live subprocess, sends `signal` once `marker` appears on its
 * stderr, and resolves with the exit code and the output.
 *
 * The `starting` line is written *inside* `startClientApp`, before the children
 * have finished spawning, so a signal sent at that moment arrives while startup
 * is still in progress.
 *
 * Node is started directly (`--import tsx`) rather than through `npx tsx`: the
 * signal must reach the agent process itself, and an `npx` wrapper in between
 * would swallow it.
 */
function runCliUntilMarker(args: string[], marker: string, signal: NodeJS.Signals): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/client/main.ts', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, [TOKEN_ENV]: CLIENT_TOKEN },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${JSON.stringify(marker)}; stderr was:\n${stderr}`));
    }, 60_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (signalled || !stderr.includes(marker)) return;
      signalled = true;
      child.kill(signal);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

/** Starts an agent from `serversBlock` and waits for the tunnel to be connected. */
async function startAgent(serversBlock: string, options: { logFile?: string } = {}): Promise<ClientApp> {
  const path = writeConfig(configYaml(serversBlock, options));
  const agent = await startClientApp(loadClientConfig(path, testEnv()));
  running = agent;
  await waitFor(() => agent.tunnel.state === 'connected', 'the tunnel to connect');
  return agent;
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
  dir = mkdtempSync(join(tmpdir(), 'client-app-'));
  counter = 0;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// startClientApp: config file -> running agent
// ---------------------------------------------------------------------------

describe('startClientApp', () => {
  it('starts both servers, connects the tunnel and shows both up on /status', async () => {
    const logFile = join(dir, 'agent.log');
    const agent = await startAgent(fixtureEntry('alpha') + fixtureEntry('beta'), { logFile });

    expect([...agent.servers.keys()].sort()).toEqual(['alpha', 'beta']);
    expect(agent.servers.get('alpha')?.available).toBe(true);

    const status = await fetchStatus();
    expect(status.clients).toHaveLength(1);
    expect(status.clients[0]?.clientId).toBe('client-app-test');
    expect(status.clients[0]?.servers).toEqual([
      { name: 'alpha', up: true },
      { name: 'beta', up: true },
    ]);

    // The log file holds JSON lines and never the token, even though the token is
    // part of this process' configuration and appears in the endpoint URL's world.
    const logged = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain(CLIENT_TOKEN);
    }
    expect(logged.some((line) => (JSON.parse(line) as { message?: string }).message === 'starting')).toBe(true);
  });

  it('relays a tools/call from the Warren endpoint to the right fixture child', async () => {
    await startAgent(fixtureEntry('alpha') + fixtureEntry('beta'));
    await waitFor(async () => (await fetchStatus()).clients[0]?.servers.every((s) => s.up) === true, 'both servers to be up');

    const alpha = await connectServer('alpha');
    expect(await alpha.callTool({ name: 'echo', arguments: { text: 'through the app' } })).toEqual({
      content: [{ type: 'text', text: 'echo:through the app' }],
    });
    expect((await alpha.listTools()).tools.map((t) => t.name)).toContain('echo');
    await alpha.close();
  });

  it('keeps a server with a bad command down while the good one works', async () => {
    const agent = await startAgent(`${fixtureEntry('good')}  broken:\n    command: definitely-not-a-real-command-xyz\n    args: []\n`);

    const broken = agent.servers.get('broken');
    if (!broken) throw new Error('the broken server is not in the map');
    expect(broken.available).toBe(false);
    expect(broken.currentState).not.toBe('running');
    expect(agent.servers.get('good')?.available).toBe(true);

    const status = await fetchStatus();
    expect(status.clients[0]?.servers).toEqual([{ name: 'good', up: true }]);

    const good = await connectServer('good');
    expect(await good.callTool({ name: 'echo', arguments: { text: 'still working' } })).toEqual({
      content: [{ type: 'text', text: 'echo:still working' }],
    });
    await good.close();

    // An unreachable name is an offline endpoint, not a crashed agent.
    expect((await rawInitialize('broken')).status).toBe(503);
  });

  it('close() stops the tunnel and leaves no child process behind', async () => {
    const agent = await startAgent(fixtureEntry('alpha') + fixtureEntry('beta'));
    const pids = [...agent.servers.values()].map((server) => server.pid);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(typeof pid).toBe('number');
      expect(isAlive(pid as number)).toBe(true);
    }

    await agent.close();
    // Idempotent: a second close (a signal arriving during shutdown) must not throw.
    await agent.close();
    running = undefined;

    expect(agent.tunnel.state).toBe('stopped');
    for (const pid of pids) await waitFor(() => !isAlive(pid as number), `child ${pid} to exit`);
    expect((await fetchStatus()).clients).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the CLI
// ---------------------------------------------------------------------------

describe('main.ts signals', () => {
  it('shuts down cleanly when SIGTERM arrives while startup is still running', async () => {
    // `starting` is logged inside `startClientApp`, before the children have
    // finished spawning: the signal therefore lands mid-startup, which is the
    // case a plain `Ctrl+C` in a terminal hits. The handler must already be
    // installed, and the agent must still close (exit 0, `closed` logged).
    const path = writeConfig(configYaml(fixtureEntry('alpha')));
    const result = await runCliUntilMarker(['--config', path], '"message":"starting"', 'SIGTERM');
    expect(result.stderr).toContain('"message":"signal"');
    expect(result.stderr).toContain('"message":"closed"');
    expect(result.status).toBe(0);
  });
});

describe('main.ts --check', () => {
  it('exits 0 and prints "config ok" for a valid file, without connecting', () => {
    const path = writeConfig(configYaml(fixtureEntry('alpha')));
    const result = runCli(['--config', path, '--check'], { [TOKEN_ENV]: CLIENT_TOKEN });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('config ok');
    expect(result.stderr).toBe('');
  });

  it('exits 0 for a file with the filesystem server enabled, resolving its bin', () => {
    // The install task's gate: `--check` must run the same filesystem bin
    // resolution the agent does, so a half-installed package fails here instead
    // of at the first start. With the package intact this stays `config ok`.
    const path = writeConfig(configYaml(fixtureEntry('alpha')).replace('filesystem: { enabled: false }', `filesystem: { enabled: true, roots: [${JSON.stringify(dir)}] }`));
    const result = runCli(['--config', path, '--check'], { [TOKEN_ENV]: CLIENT_TOKEN });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('config ok');
  });

  it('exits 1 and names the missing environment variable', () => {
    const path = writeConfig(
      configYaml(`${fixtureEntry('alpha')}    env:\n      API_KEY: \${env:${MISSING_ENV}}\n`),
    );
    const result = runCli(['--config', path, '--check'], { [TOKEN_ENV]: CLIENT_TOKEN });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MISSING_ENV);
    expect(result.stderr).toContain('is not set');
    expect(result.stdout).toBe('');
  });
});

/**
 * The fault paths of `src/client/app.ts` and its logger.
 *
 * Three properties that must hold on a real work PC, none of which needs a
 * tunnel to be reachable:
 *
 * - a broken `@modelcontextprotocol/server-filesystem` install is logged and the
 *   other servers still start (the agent does not abort at construction time);
 * - every child failing its *first* start does not stop the agent: the tunnel is
 *   started anyway and the supervisors keep retrying;
 * - a rotation whose rename fails leaves the byte counter *unknown* (re-stat on
 *   the next write) instead of resetting it to 0, which would let the file grow
 *   past `maxBytes` unbounded.
 *
 * `node:fs` and `./filesystem.js` are mocked with `vi.mock` so the failure can be
 * provoked without touching the real install or the filesystem permissions.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  renameSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, ...fsMock };
});

const filesystemMock = vi.hoisted(() => ({ createFilesystemServer: vi.fn() }));

vi.mock('../../src/client/filesystem.js', () => ({
  FILESYSTEM_SERVER_PACKAGE: '@modelcontextprotocol/server-filesystem',
  createFilesystemServer: filesystemMock.createFilesystemServer,
}));

const { createLogger, startClientApp } = await import('../../src/client/app.js');
const { loadClientConfig } = await import('../../src/client/config.js');

const TOKEN = 'faults-client-token-aaaaaaaaaaaaaaaa';
const TOKEN_ENV = 'FAULTS_TEST_TOKEN';
/** A command that cannot be spawned: its first start fails immediately. */
const BROKEN_COMMAND = 'definitely-not-a-real-command-xyz';
/** The real fixture used by the other integration tests: starts cleanly. */
const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

let dir = '';
let stderrLines: string[] = [];

/** A config document with one server and the filesystem server enabled. */
function configText(command: string, args: string[]): string {
  return [
    'server:',
    '  url: ws://127.0.0.1:1/tunnel',
    `  token: \${env:${TOKEN_ENV}}`,
    'clientId: faults-test',
    'log: { level: debug }',
    'filesystem: { enabled: true, roots: ["/tmp"] }',
    'servers:',
    '  alpha:',
    `    command: ${JSON.stringify(command)}`,
    `    args: [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '',
  ].join('\n');
}

function writeConfig(text: string): string {
  const path = join(dir, 'config.yaml');
  // `writeFileSync` comes from the mocked module, which spreads the real `node:fs`
  // and only replaces the four calls `app.ts` makes.
  writeFileSync(path, text, 'utf8');
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'client-faults-'));
});

beforeEach(() => {
  stderrLines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
  fsMock.renameSync.mockReset();
  fsMock.appendFileSync.mockReset();
  fsMock.statSync.mockReset();
  fsMock.existsSync.mockReset();
  fsMock.unlinkSync.mockReset();
  filesystemMock.createFilesystemServer.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger rotation', () => {
  const logConfig = { level: 'debug' as const, file: '/tmp/agent.log', maxBytes: 100, maxBackups: 1 };

  it('rotates when the file passes maxBytes', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ size: 0 } as never);
    const log = createLogger(logConfig);
    // Enough bytes to exceed maxBytes in a couple of writes.
    for (let i = 0; i < 5; i += 1) log({ level: 'info', message: 'x'.repeat(40) });
    expect(fsMock.renameSync).toHaveBeenCalled();
  });

  it('re-stats instead of resetting to 0 when the rename fails', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ size: 0 } as never);
    // Every rename fails (e.g. the backup path is a directory, or a permission
    // problem on the volume).
    fsMock.renameSync.mockImplementation(() => {
      throw new Error('EISDIR: illegal operation on a directory');
    });
    const log = createLogger(logConfig);
    log({ level: 'info', message: 'x'.repeat(80) });
    // First write triggers a rotation attempt; the failed rename must leave the
    // size *unknown*, so the next write re-stats the file rather than trusting 0.
    fsMock.statSync.mockClear();
    log({ level: 'info', message: 'y'.repeat(80) });
    expect(fsMock.renameSync).toHaveBeenCalled();
    expect(fsMock.statSync).toHaveBeenCalled();
  });
});

describe('startClientApp fault tolerance', () => {
  it('logs a broken filesystem install and still starts the other servers', async () => {
    filesystemMock.createFilesystemServer.mockImplementation(() => {
      throw new Error('the built-in filesystem server needs the package installed next to this file');
    });
    const path = writeConfig(configText());
    const app = await startClientApp(loadClientConfig(path, { [TOKEN_ENV]: TOKEN }));
    try {
      expect(app.servers.has('filesystem')).toBe(false);
      expect(app.servers.has('alpha')).toBe(true);
      expect(stderrLines.join('')).toContain('filesystem server could not be created');
    } finally {
      await app.close();
    }
  });

  it('starts the tunnel even when every child fails its first start', async () => {
    filesystemMock.createFilesystemServer.mockImplementation(() => {
      throw new Error('filesystem unavailable');
    });
    const path = writeConfig(configText());
    const app = await startClientApp(loadClientConfig(path, { [TOKEN_ENV]: TOKEN }));
    try {
      // Nothing is available, yet the agent is up: the supervisors retry and the
      // tunnel keeps dialing, so a PC that was merely slow recovers on its own.
      expect([...app.servers.values()].every((server) => !server.available)).toBe(true);
      expect(app.tunnel.state).not.toBe('stopped');
    } finally {
      await app.close();
    }
  });
});

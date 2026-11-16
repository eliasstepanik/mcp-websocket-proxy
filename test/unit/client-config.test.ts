/**
 * Unit tests for `src/client/config.ts`.
 *
 * Everything is driven through {@link checkConfigText}/{@link loadClientConfig}
 * with a temp file on disk, because the file format (YAML *and* JSON), the
 * `${env:VAR}` expansion and the error wording are the contract. The security-
 * relevant assertions are the ones on `ws://` and on error messages never
 * leaking a value.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hostname } from 'node:os';

import {
  ConfigError,
  DEFAULT_FILESYSTEM_SERVER_NAME,
  LOG_MAX_BACKUPS,
  LOG_MAX_BYTES,
  checkConfig,
  checkConfigText,
  loadClientConfig,
  normalizeServerName,
  type ClientConfig,
} from '../../src/client/config.js';

const TOKEN = 'client-token-aaaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'super-secret-api-key-value';

let dir = '';
let counter = 0;

/** Write `text` to a fresh temp file and return its path. */
function writeConfig(text: string, extension = '.yaml'): string {
  counter += 1;
  const path = join(dir, `config-${counter}${extension}`);
  writeFileSync(path, text, 'utf8');
  return path;
}

/** A minimal valid document body; callers override single fields. */
function minimal(overrides?: Record<string, unknown>): string {
  const doc = {
    server: { url: 'wss://warren.example.com/tunnel', token: '${env:MCP_PROXY_CLIENT_TOKEN}' },
    filesystem: { roots: ['C:\\Users\\me\\Projects'] },
    ...overrides,
  };
  return JSON.stringify(doc, null, 2);
}

const baseEnv = (): NodeJS.ProcessEnv => ({ MCP_PROXY_CLIENT_TOKEN: TOKEN });

/** `loadClientConfig` on a YAML string, with the token env var set. */
function load(text: string, env: NodeJS.ProcessEnv = baseEnv()): ClientConfig {
  return loadClientConfig(writeConfig(text), env);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'client-config-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadClientConfig: formats and defaults', () => {
  it('parses YAML', () => {
    const config = load(
      `
server:
  url: wss://warren.example.com/tunnel
  token: \${env:MCP_PROXY_CLIENT_TOKEN}
clientId: work-pc
log:
  level: debug
  file: 'C:\\Users\\me\\app.log'
filesystem:
  enabled: true
  roots:
    - 'C:\\Users\\me\\Projects'
servers:
  some-server:
    command: npx
    args: ['-y', 'some-mcp-server']
    env: { API_KEY: '\${env:SOME_KEY}' }
    cwd: 'C:\\work'
`,
      { MCP_PROXY_CLIENT_TOKEN: TOKEN, SOME_KEY: SECRET },
    );
    expect(config.server).toEqual({ url: 'wss://warren.example.com/tunnel', token: TOKEN, allowInsecure: false });
    expect(config.clientId).toBe('work-pc');
    expect(config.log).toEqual({
      level: 'debug',
      file: 'C:\\Users\\me\\app.log',
      maxBytes: LOG_MAX_BYTES,
      maxBackups: LOG_MAX_BACKUPS,
    });
    expect(config.filesystem).toEqual({ enabled: true, name: DEFAULT_FILESYSTEM_SERVER_NAME, roots: ['C:\\Users\\me\\Projects'] });
    expect([...config.servers.keys()]).toEqual(['some-server']);
    expect(config.servers.get('some-server')).toEqual({
      name: 'some-server',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { API_KEY: SECRET },
      cwd: 'C:\\work',
      inheritEnv: false,
    });
  });

  it('parses the same document as JSON', () => {
    const config = load(minimal());
    expect(config.server.token).toBe(TOKEN);
    expect(config.filesystem.roots).toEqual(['C:\\Users\\me\\Projects']);
  });

  it('applies the documented defaults', () => {
    const config = load(minimal());
    expect(config.clientId).toBe(hostname());
    expect(config.log).toEqual({ level: 'info', maxBytes: LOG_MAX_BYTES, maxBackups: LOG_MAX_BACKUPS });
    expect(config.filesystem).toEqual({ enabled: true, name: 'filesystem', roots: ['C:\\Users\\me\\Projects'] });
    expect(config.servers.size).toBe(0);
  });

  it('defaults clientId to os.hostname()', () => {
    expect(load(minimal()).clientId).toBe(hostname());
    expect(load(minimal({ clientId: '  work-pc  ' })).clientId).toBe('work-pc');
  });

  it('accepts a short token: length is the server\'s policy, not ours', () => {
    expect(load(minimal({ server: { url: 'wss://h/tunnel', token: 'x' } })).server.token).toBe('x');
  });

  it('reports a missing file instead of throwing a raw ENOENT', () => {
    const missing = join(dir, 'does-not-exist.yaml');
    expect(() => loadClientConfig(missing)).toThrow(ConfigError);
    expect(checkConfig(missing).errors[0]).toContain('cannot read config file');
  });

  it('rejects an empty or non-map document', () => {
    expect(checkConfigText('', baseEnv()).errors).toContain('config file is empty');
    expect(checkConfigText('- just\n- a\n- list\n', baseEnv()).errors).toContain('config must be a map of settings');
    expect(checkConfigText('{ not yaml: [', baseEnv()).errors[0]).toContain('not valid YAML or JSON');
  });
});

describe('${env:VAR} expansion', () => {
  it('expands inside nested server env maps and everywhere else', () => {
    const config = load(
      minimal({
        clientId: '${env:CLIENT_ID}',
        servers: {
          a: { command: '${env:CMD}', args: ['--key', '${env:KEY}'], env: { API_KEY: '${env:API_KEY}', OTHER: 'pre-${env:KEY}-post' } },
        },
      }),
      {
        MCP_PROXY_CLIENT_TOKEN: TOKEN,
        CLIENT_ID: 'laptop',
        CMD: 'npx',
        KEY: 'k1',
        API_KEY: SECRET,
      },
    );
    expect(config.clientId).toBe('laptop');
    const server = config.servers.get('a');
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['--key', 'k1']);
    expect(server?.env).toEqual({ API_KEY: SECRET, OTHER: `pre-k1-post` });
  });

  it('names a missing variable and never prints a value', () => {
    const env = { MCP_PROXY_CLIENT_TOKEN: TOKEN };
    const text = minimal({ servers: { a: { command: 'npx', env: { API_KEY: '${env:' + 'MISSING_KEY' + '}', TOKEN: '${env:MCP_PROXY_CLIENT_TOKEN}' } } } });
    const check = checkConfigText(text, env);
    expect(check.ok).toBe(false);
    const joined = check.errors.join('\n');
    expect(joined).toContain('MISSING_KEY');
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain(TOKEN);
    // loadClientConfig throws the same message, wrapped in a ConfigError.
    let message = '';
    try {
      loadClientConfig(writeConfig(text), env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain('MISSING_KEY');
    expect(message).not.toContain(TOKEN);
  });

  it('rejects a blank token like a missing one', () => {
    const check = checkConfigText(minimal(), { MCP_PROXY_CLIENT_TOKEN: '   ' });
    expect(check.errors).toContain('server.token must not be empty');
  });
});

describe('server.url', () => {
  it('accepts ws:// for local hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(load(minimal({ server: { url: `ws://${host}:8080/tunnel`, token: '${env:MCP_PROXY_CLIENT_TOKEN}' } })).server.url).toBe(
        `ws://${host}:8080/tunnel`,
      );
    }
  });

  it('rejects ws:// for a remote host, naming the host', () => {
    const check = checkConfigText(minimal({ server: { url: 'ws://work.example.com/tunnel', token: '${env:MCP_PROXY_CLIENT_TOKEN}' } }), baseEnv());
    expect(check.ok).toBe(false);
    expect(check.errors.join('\n')).toMatch(/ws:\/\/.*work\.example\.com/);
  });

  it('accepts wss:// for any host', () => {
    expect(load(minimal({ server: { url: 'wss://work.example.com/tunnel', token: '${env:MCP_PROXY_CLIENT_TOKEN}' } })).server.url).toBe(
      'wss://work.example.com/tunnel',
    );
  });

  it('lets allowInsecure override the ws:// rule', () => {
    const config = load(
      minimal({ server: { url: 'ws://work.example.com/tunnel', token: '${env:MCP_PROXY_CLIENT_TOKEN}', allowInsecure: true } }),
    );
    expect(config.server.allowInsecure).toBe(true);
  });

  it('rejects other schemes and garbage', () => {
    for (const url of ['http://host/tunnel', 'not a url']) {
      expect(checkConfigText(minimal({ server: { url, token: '${env:MCP_PROXY_CLIENT_TOKEN}' } }), baseEnv()).ok).toBe(false);
    }
  });

  it('requires url and token', () => {
    const check = checkConfigText('filesystem:\n  roots: ["/tmp"]\n', baseEnv());
    expect(check.errors).toContain('server.url is required');
    expect(check.errors).toContain('server.token is required');
  });
});

describe('server names', () => {
  it('rejects a name that does not match SERVER_NAME_RE', () => {
    for (const name of ['Bad_Name', '-lead', '', 'a'.repeat(64)]) {
      const check = checkConfigText(minimal({ servers: { [name || ' ']: { command: 'npx' } } }), baseEnv());
      expect(check.errors.join('\n')).toContain('invalid server name');
    }
  });

  it('rejects duplicates, including one that differs only by case', () => {
    const check = checkConfigText(
      minimal({ servers: { files: { command: 'a' }, Files: { command: 'b' } } }),
      baseEnv(),
    );
    expect(check.errors.join('\n')).toContain('duplicate server name "files"');
    expect(normalizeServerName(' Files ')).toBe('files');
  });

  it('rejects a server that clashes with filesystem.name', () => {
    const check = checkConfigText(
      minimal({ filesystem: { roots: ['/tmp'], name: 'files' }, servers: { files: { command: 'a' } } }),
      baseEnv(),
    );
    expect(check.errors.join('\n')).toContain('already used by the filesystem server');
  });

  it('rejects a filesystem.name that is not a legal server name', () => {
    const check = checkConfigText(minimal({ filesystem: { roots: ['/tmp'], name: 'Bad Name' } }), baseEnv());
    expect(check.errors.join('\n')).toContain('filesystem.name must match');
  });

  it('allows a clash when the filesystem server is disabled', () => {
    const check = checkConfigText(
      minimal({ filesystem: { enabled: false }, servers: { filesystem: { command: 'a' } } }),
      baseEnv(),
    );
    expect(check.ok).toBe(true);
    expect(check.config?.servers.get('filesystem')?.command).toBe('a');
  });
});

describe('what counts as a server', () => {
  it('rejects an empty config: no servers and filesystem disabled', () => {
    const check = checkConfigText(minimal({ filesystem: { enabled: false } }), baseEnv());
    expect(check.errors).toContain('config exposes no servers: add an entry under `servers` or enable the filesystem server');
  });

  it('accepts an empty `servers` when the filesystem server is enabled', () => {
    expect(checkConfigText(minimal(), baseEnv()).ok).toBe(true);
  });

  it('requires filesystem.roots when the filesystem server is enabled', () => {
    const check = checkConfigText(minimal({ filesystem: {} }), baseEnv());
    expect(check.errors).toContain('filesystem.roots is required when the filesystem server is enabled');
    // Not required when disabled, as long as something else is exposed.
    expect(
      checkConfigText(minimal({ filesystem: { enabled: false }, servers: { a: { command: 'npx' } } }), baseEnv()).ok,
    ).toBe(true);
  });
});

describe('log section', () => {
  it('accepts the four levels, case-insensitively', () => {
    for (const level of ['debug', 'INFO', 'Warn', 'error']) {
      expect(load(minimal({ log: { level } })).log.level).toBe(level.toLowerCase());
    }
  });

  it('rejects an unknown level', () => {
    const check = checkConfigText(minimal({ log: { level: 'trace' } }), baseEnv());
    expect(check.errors.join('\n')).toContain('log.level must be one of debug, info, warn, error');
  });
});

describe('server entries', () => {
  it('requires command and rejects wrong types', () => {
    const check = checkConfigText(
      minimal({ servers: { a: { args: 'not-a-list', env: 'nope', cwd: 5, inheritEnv: 'yes' }, b: 'not-a-map' } }),
      baseEnv(),
    );
    const joined = check.errors.join('\n');
    expect(joined).toContain('servers.a.command is required');
    expect(joined).toContain('servers.a.args must be a list of strings');
    expect(joined).toContain('servers.a.env must be a map of names to string values');
    expect(joined).toContain('servers.a.cwd must be a string');
    expect(joined).toContain('servers.a.inheritEnv must be true or false');
    expect(joined).toContain('servers.b must be a map with at least a `command`');
  });

  it('reads inheritEnv and defaults it to false', () => {
    const config = load(minimal({ servers: { a: { command: 'npx', inheritEnv: true }, b: { command: 'npx' } } }));
    expect(config.servers.get('a')?.inheritEnv).toBe(true);
    expect(config.servers.get('b')?.inheritEnv).toBe(false);
  });
});

describe('checkConfig', () => {
  it('returns ok with no errors for a valid file', () => {
    const path = writeConfig(minimal());
    expect(checkConfig(path, baseEnv())).toEqual({ ok: true, errors: [] });
  });

  it('lists every problem at once instead of throwing', () => {
    const path = writeConfig('server:\n  url: ws://remote.example.com/tunnel\nlog:\n  level: chatty\nfilesystem:\n  enabled: false\n');
    const check = checkConfig(path, baseEnv());
    expect(check.ok).toBe(false);
    expect(check.errors.length).toBeGreaterThanOrEqual(4);
    expect(check.errors.join('\n')).toContain('server.token is required');
    expect(check.errors.join('\n')).toContain('unencrypted ws://');
    expect(check.errors.join('\n')).toContain('log.level must be one of');
    expect(check.errors.join('\n')).toContain('config exposes no servers');
  });
});

/**
 * T3 proof: the HTTP surface of {@link createApp} is authenticated.
 *
 * Startup validation of the two tokens lives in `test/unit/config.test.ts`; this
 * file covers what an attacker actually sees:
 *
 * - `POST /mcp/<name>`   -> 401 + `WWW-Authenticate` + a JSON-RPC error body for a
 *                           missing, wrong or *client*-audience bearer token
 * - `upgrade /tunnel`    -> a plain 401 (no WebSocket handshake) for a wrong or
 *                           endpoint-audience bearer token
 * - `GET /healthz`       -> 200 with no credentials at all (load balancers)
 * - `GET /status`        -> 401 without the endpoint token, 200 with it, listing the
 *                           connected client and its servers
 *
 * The last block asserts the request log never carries a token: `createApp` accepts
 * an `onRequest` callback, so the log is injectable and can be captured here.
 */

import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type App, type RequestLogEntry } from '../../src/server/app.js';
import { bearerHeader } from '../../src/server/auth.js';
import { LocalMcpServer } from '../../src/client/local-server.js';
import { TunnelClient } from '../../src/client/tunnel-client.js';

const FIXTURE = new URL('../fixtures/fake-mcp-server.mjs', import.meta.url).pathname;

const CLIENT_ID = 'auth-pc';
/** Distinct tokens, each >= 32 characters (the floor `config.ts` enforces). */
const CLIENT_TOKEN = 'auth-client-token-aaaaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'auth-endpoint-token-bbbbbbbbbbbbbbbb';
const WRONG_TOKEN = 'wrong-token-cccccccccccccccccccccccc';

let app: App | undefined;
let baseUrl = '';
let tunnelUrl = '';
/** Everything {@link createApp} logged while the tests ran. */
const logged: RequestLogEntry[] = [];

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One plain HTTP call; the body is returned as text, never parsed. */
async function http(
  path: string,
  init: { method?: string; authorization?: string } = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    ...(init.authorization === undefined ? {} : { headers: { authorization: init.authorization } }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

/** The outcome of a raw `upgrade /tunnel` request. */
interface UpgradeResult {
  /** True when the server answered 101 and a WebSocket was established. */
  upgraded: boolean;
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A raw WebSocket upgrade request (what a tunnel client sends), so a rejected
 * handshake can be inspected instead of being hidden by the `ws` client.
 */
function rawUpgrade(url: string, authorization?: string): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        ...(authorization === undefined ? {} : { authorization }),
      },
    });
    req.on('upgrade', () => {
      req.destroy();
      resolve({ upgraded: true, status: 101, headers: {}, body: '' });
    });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ upgraded: false, status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  app = createApp({
    clientToken: CLIENT_TOKEN,
    endpointToken: ENDPOINT_TOKEN,
    onRequest: (entry) => {
      logged.push(entry);
    },
  });
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

// ---------------------------------------------------------------------------
// /mcp/<name>: only the endpoint token opens a session
// ---------------------------------------------------------------------------

describe('/mcp/<name> bearer auth', () => {
  /** The shape every rejection must have: challenge header + JSON-RPC error body. */
  const expectUnauthorized = async (path: string, authorization?: string): Promise<void> => {
    const response = await http(path, { method: 'POST', ...(authorization === undefined ? {} : { authorization }) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="mcp-proxy"');
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = JSON.parse(response.text) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe('Unauthorized: a valid bearer token is required');
    // The message explains the requirement without ever echoing a secret.
    expect(response.text).not.toContain(CLIENT_TOKEN);
    expect(response.text).not.toContain(ENDPOINT_TOKEN);
    expect(response.text).not.toContain(WRONG_TOKEN);
  };

  it('rejects a request with no Authorization header', async () => {
    await expectUnauthorized('/mcp/alpha');
  });

  it('rejects a wrong bearer token', async () => {
    await expectUnauthorized('/mcp/alpha', bearerHeader(WRONG_TOKEN));
  });

  it('rejects the client token: the two audiences are not interchangeable', async () => {
    await expectUnauthorized('/mcp/alpha', bearerHeader(CLIENT_TOKEN));
  });

  it('rejects another scheme and an empty token', async () => {
    await expectUnauthorized('/mcp/alpha', `Basic ${Buffer.from('a:b').toString('base64')}`);
    await expectUnauthorized('/mcp/alpha', 'Bearer ');
  });

  it('rejects a token that merely starts with the endpoint token', async () => {
    await expectUnauthorized('/mcp/alpha', bearerHeader(`${ENDPOINT_TOKEN}suffix`));
  });
});

// ---------------------------------------------------------------------------
// upgrade /tunnel: only the client token gets a WebSocket
// ---------------------------------------------------------------------------

describe('upgrade /tunnel bearer auth', () => {
  it('rejects an upgrade with no Authorization header', async () => {
    const result = await rawUpgrade(tunnelUrl);
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(401);
    expect(String(result.headers['www-authenticate'])).toContain('Bearer');
    expect(result.body).not.toContain(CLIENT_TOKEN);
    expect(result.body).not.toContain(ENDPOINT_TOKEN);
  });

  it('rejects an upgrade with a wrong token', async () => {
    const result = await rawUpgrade(tunnelUrl, bearerHeader(WRONG_TOKEN));
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(401);
  });

  it('rejects an upgrade with the endpoint token: the audiences do not mix', async () => {
    const result = await rawUpgrade(tunnelUrl, bearerHeader(ENDPOINT_TOKEN));
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts an upgrade with the client token', async () => {
    const result = await rawUpgrade(tunnelUrl, bearerHeader(CLIENT_TOKEN));
    expect(result.upgraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /healthz: no credentials required
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('answers 200 without any Authorization header', async () => {
    const response = await http('/healthz');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ status: 'ok' });
  });

  it('still answers 200 when a bogus token is sent', async () => {
    expect((await http('/healthz', { authorization: bearerHeader(WRONG_TOKEN) })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /status: the endpoint token, and it lists who is connected
// ---------------------------------------------------------------------------

describe('GET /status', () => {
  let local: LocalMcpServer | undefined;
  let client: TunnelClient | undefined;

  beforeEach(async () => {
    local = new LocalMcpServer({
      name: 'alpha',
      command: process.execPath,
      args: [FIXTURE],
      restart: false,
      requestTimeoutMs: 20_000,
      onStderrLine: () => undefined,
    });
    await local.start();
    client = new TunnelClient({
      url: tunnelUrl,
      token: CLIENT_TOKEN,
      clientId: CLIENT_ID,
      servers: new Map([['alpha', local]]),
    });
    await waitFor(() => app?.registry.lookup('alpha')?.up === true, 'alpha to be registered');
  });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await local?.stop();
    local = undefined;
  });

  it('rejects a request with no Authorization header', async () => {
    const response = await http('/status');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="mcp-proxy"');
    expect(JSON.parse(response.text).error.code).toBe(-32000);
  });

  it('rejects the client token', async () => {
    expect((await http('/status', { authorization: bearerHeader(CLIENT_TOKEN) })).status).toBe(401);
  });

  it('lists the connected client with its servers when the endpoint token is sent', async () => {
    const response = await http('/status', { authorization: bearerHeader(ENDPOINT_TOKEN) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as {
      serverVersion: string;
      clients: { clientId: string; servers: { name: string; up: boolean }[] }[];
    };
    expect(body.serverVersion).toBe('unknown');
    expect(body.clients).toEqual([{ clientId: CLIENT_ID, servers: [{ name: 'alpha', up: true }] }]);
    // A status page is a natural log target: it must not leak the tokens.
    expect(response.text).not.toContain(CLIENT_TOKEN);
    expect(response.text).not.toContain(ENDPOINT_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The request log never carries a token
// ---------------------------------------------------------------------------

describe('request log hygiene', () => {
  it('logs method, path and status only, for authenticated and rejected requests alike', async () => {
    logged.length = 0;
    await http('/healthz');
    await http('/mcp/alpha', { method: 'POST' });
    await http('/mcp/alpha', { method: 'POST', authorization: bearerHeader(CLIENT_TOKEN) });
    await http('/status', { authorization: bearerHeader(ENDPOINT_TOKEN) });
    await rawUpgrade(tunnelUrl, bearerHeader(WRONG_TOKEN));

    expect(logged.length).toBeGreaterThanOrEqual(4);
    for (const entry of logged) {
      const line = JSON.stringify(entry);
      expect(line).not.toContain(CLIENT_TOKEN);
      expect(line).not.toContain(ENDPOINT_TOKEN);
      expect(line).not.toContain(WRONG_TOKEN);
      expect(line).not.toContain('Bearer');
      expect(Object.keys(entry).sort()).toEqual(['durationMs', 'method', 'path', 'status']);
    }
    expect(logged.some((entry) => entry.path === '/healthz' && entry.status === 200)).toBe(true);
    expect(logged.some((entry) => entry.path === '/mcp/alpha' && entry.status === 401)).toBe(true);
    expect(logged.some((entry) => entry.path === '/status' && entry.status === 200)).toBe(true);
  });
});

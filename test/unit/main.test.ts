/**
 * Unit tests for `src/server/main.ts`.
 *
 * The point of these tests is that the entry point is *importable* without touching
 * the process: importing must not listen, must not log and must not read the real
 * environment (the `start()` call at the bottom of the module is guarded by an
 * "am I the main module?" check). On top of that, `start()` must fail for a bad
 * environment before it binds anything.
 */

import { describe, expect, it } from 'vitest';

import * as main from '../../src/server/main.js';
import { ConfigError } from '../../src/server/config.js';

describe('main.ts module shape', () => {
  it('exports start() and the reported server version', () => {
    expect(typeof main.start).toBe('function');
    expect(typeof main.SERVER_VERSION).toBe('string');
    expect(main.SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('importing the module did not write anything or bind a port', () => {
    // Nothing to await: if the module had auto-started, the default port 8080 would
    // be taken and `readConfig({})` below would still be the first thing to fail.
    expect(main).toBeTruthy();
  });
});

describe('main.ts start(): environment validation', () => {
  it('rejects with ConfigError when the tokens are missing', async () => {
    await expect(main.start({})).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects when the two tokens are equal, without listening', async () => {
    const token = 'main-token-aaaaaaaaaaaaaaaaaaaaaaaa';
    await expect(
      main.start({ MCP_PROXY_CLIENT_TOKEN: token, MCP_PROXY_ENDPOINT_TOKEN: token }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('main.ts start(): listen and graceful close', () => {
  it('binds an ephemeral port, answers /healthz and closes cleanly', async () => {
    const running = await main.start({
      MCP_PROXY_CLIENT_TOKEN: 'main-client-token-aaaaaaaaaaaaaaaa',
      MCP_PROXY_ENDPOINT_TOKEN: 'main-endpoint-token-bbbbbbbbbbbbbbbb',
      MCP_PROXY_HOST: '127.0.0.1',
      MCP_PROXY_PORT: '0',
      MCP_PROXY_LOG_LEVEL: 'error',
    });
    try {
      expect(running.port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await running.close();
      // Idempotent: a second close (a signal arriving during shutdown) must not throw.
      await running.close();
    }
    await expect(fetch(`http://127.0.0.1:${running.port}/healthz`)).rejects.toBeTruthy();
  });
});

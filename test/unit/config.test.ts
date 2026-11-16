/**
 * Unit tests for `src/server/config.ts`: defaults, parsing and — the important
 * part — startup validation of the two tokens.
 *
 * A test token is 32+ characters long (the minimum the server accepts); the
 * assertions on error messages check that the *variable name* appears, because
 * that is what makes a startup failure actionable, and that no token value leaks.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, MIN_TOKEN_LENGTH, readConfig } from '../../src/server/config.js';

const CLIENT_TOKEN = 'client-token-aaaaaaaaaaaaaaaaaaaaaaa';
const ENDPOINT_TOKEN = 'endpoint-token-bbbbbbbbbbbbbbbbbbbbbbb';

/** A valid environment: callers override single keys to test each failure. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    MCP_PROXY_CLIENT_TOKEN: CLIENT_TOKEN,
    MCP_PROXY_ENDPOINT_TOKEN: ENDPOINT_TOKEN,
    ...overrides,
  };
}

describe('readConfig: defaults', () => {
  it('applies the documented defaults when only the tokens are set', () => {
    const config = readConfig(env());
    expect(config).toEqual({
      clientToken: CLIENT_TOKEN,
      endpointToken: ENDPOINT_TOKEN,
      port: 8080,
      host: '0.0.0.0',
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 30_000,
      requestTimeoutMs: 300_000,
      maxMessageBytes: 33_554_432,
      sessionIdleTtlMs: 604_800_000,
      logLevel: 'info',
    });
  });

  it('reads every variable when they are all set', () => {
    const config = readConfig(
      env({
        MCP_PROXY_PORT: '9000',
        MCP_PROXY_HOST: '127.0.0.1',
        MCP_PROXY_HEARTBEAT_INTERVAL_MS: '1000',
        MCP_PROXY_HEARTBEAT_TIMEOUT_MS: '5000',
        MCP_PROXY_REQUEST_TIMEOUT_MS: '60000',
        MCP_PROXY_MAX_MESSAGE_BYTES: '1024',
        MCP_PROXY_SESSION_IDLE_TTL_MS: '2000',
        MCP_PROXY_LOG_LEVEL: 'DEBUG',
      }),
    );
    expect(config.port).toBe(9000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.heartbeatIntervalMs).toBe(1000);
    expect(config.heartbeatTimeoutMs).toBe(5000);
    expect(config.requestTimeoutMs).toBe(60000);
    expect(config.maxMessageBytes).toBe(1024);
    expect(config.sessionIdleTtlMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
  });

  it('falls back to the default for a blank value', () => {
    expect(readConfig(env({ MCP_PROXY_PORT: '  ' })).port).toBe(8080);
  });
});

describe('readConfig: token validation', () => {
  it('rejects a missing client token, naming the variable', () => {
    expect(() => readConfig(env({ MCP_PROXY_CLIENT_TOKEN: undefined }))).toThrow(/MCP_PROXY_CLIENT_TOKEN is required/);
  });

  it('rejects a missing endpoint token, naming the variable', () => {
    expect(() => readConfig(env({ MCP_PROXY_ENDPOINT_TOKEN: undefined }))).toThrow(/MCP_PROXY_ENDPOINT_TOKEN is required/);
  });

  it('rejects a blank token like a missing one', () => {
    expect(() => readConfig(env({ MCP_PROXY_CLIENT_TOKEN: '   ' }))).toThrow(/MCP_PROXY_CLIENT_TOKEN is required/);
  });

  it('rejects a client token shorter than the minimum', () => {
    const short = 'x'.repeat(MIN_TOKEN_LENGTH - 1);
    expect(() => readConfig(env({ MCP_PROXY_CLIENT_TOKEN: short }))).toThrow(/MCP_PROXY_CLIENT_TOKEN is too short.*32/);
  });

  it('rejects a short endpoint token', () => {
    expect(() => readConfig(env({ MCP_PROXY_ENDPOINT_TOKEN: 'short' }))).toThrow(/MCP_PROXY_ENDPOINT_TOKEN is too short/);
  });

  it('accepts a token of exactly the minimum length', () => {
    const exact = 'z'.repeat(MIN_TOKEN_LENGTH);
    expect(readConfig(env({ MCP_PROXY_CLIENT_TOKEN: exact })).clientToken).toBe(exact);
  });

  it('rejects two identical tokens', () => {
    expect(() => readConfig(env({ MCP_PROXY_ENDPOINT_TOKEN: CLIENT_TOKEN }))).toThrow(/must be different/);
  });

  it('never puts a token value in an error message', () => {
    const cases: Record<string, string | undefined>[] = [
      { MCP_PROXY_CLIENT_TOKEN: 's'.repeat(8) },
      { MCP_PROXY_ENDPOINT_TOKEN: CLIENT_TOKEN },
      { MCP_PROXY_CLIENT_TOKEN: undefined },
    ];
    for (const override of cases) {
      let message = '';
      try {
        readConfig(env(override));
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).not.toContain(CLIENT_TOKEN);
      expect(message).not.toContain(ENDPOINT_TOKEN);
    }
  });
});

describe('readConfig: numeric and level validation', () => {
  it('rejects a non-numeric port', () => {
    expect(() => readConfig(env({ MCP_PROXY_PORT: 'http' }))).toThrow(/MCP_PROXY_PORT/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => readConfig(env({ MCP_PROXY_PORT: '70000' }))).toThrow(/MCP_PROXY_PORT/);
  });

  it('rejects a non-positive interval', () => {
    expect(() => readConfig(env({ MCP_PROXY_REQUEST_TIMEOUT_MS: '0' }))).toThrow(/MCP_PROXY_REQUEST_TIMEOUT_MS/);
  });

  it('rejects a fractional interval', () => {
    expect(() => readConfig(env({ MCP_PROXY_HEARTBEAT_INTERVAL_MS: '1.5' }))).toThrow(/MCP_PROXY_HEARTBEAT_INTERVAL_MS/);
  });

  it('rejects a heartbeat timeout that is not longer than the interval', () => {
    expect(() =>
      readConfig(env({ MCP_PROXY_HEARTBEAT_INTERVAL_MS: '5000', MCP_PROXY_HEARTBEAT_TIMEOUT_MS: '5000' })),
    ).toThrow(/MCP_PROXY_HEARTBEAT_TIMEOUT_MS/);
  });

  it('rejects an unknown log level', () => {
    expect(() => readConfig(env({ MCP_PROXY_LOG_LEVEL: 'trace' }))).toThrow(/MCP_PROXY_LOG_LEVEL/);
  });
});

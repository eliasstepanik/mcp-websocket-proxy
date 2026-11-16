/**
 * Server configuration (T3): every knob comes from the environment, with the
 * defaults the proxy is designed around.
 *
 * Two tokens are required and they must differ:
 *
 * - `MCP_PROXY_CLIENT_TOKEN`   authenticates tunnel clients (`upgrade /tunnel`)
 * - `MCP_PROXY_ENDPOINT_TOKEN` authenticates Warren itself (`/mcp/<name>`, `/status`)
 *
 * Keeping them separate means a stolen work-PC token cannot be used to call the
 * MCP endpoints (and vice versa). {@link readConfig} enforces all of it at
 * startup, so a misconfigured server fails immediately with a message naming the
 * variable that is wrong instead of silently refusing every connection later.
 *
 * Nothing here ever logs a token: validation messages name the variable and the
 * problem, never the value.
 */

/** Console verbosity, most verbose first. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Order matters: a lower index is more verbose. */
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** The validated configuration of one server process. */
export interface ProxyConfig {
  /** Bearer token required on `upgrade /tunnel`. */
  clientToken: string;
  /** Bearer token required on `/mcp/<name>` and `/status`. */
  endpointToken: string;
  port: number;
  host: string;
  /** Interval between tunnel `ping` keepalives. */
  heartbeatIntervalMs: number;
  /** How long a tunnel may stay silent before it is terminated. */
  heartbeatTimeoutMs: number;
  /** Default per-request deadline for relayed JSON-RPC requests. */
  requestTimeoutMs: number;
  /** Size limit for tunnel frames and HTTP POST bodies. */
  maxMessageBytes: number;
  /** Idle TTL of a Warren session on an endpoint. */
  sessionIdleTtlMs: number;
  /** Console verbosity. */
  logLevel: LogLevel;
}

import { MIN_TOKEN_LENGTH } from './auth.js';

/** Raised for a bad environment: the message always names the variable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** A required token: missing/blank is an error, and the value is never echoed. */
function readToken(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`${key} is required: set it to a bearer token of at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const token = raw.trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`${key} is too short: ${token.length} characters, need at least ${MIN_TOKEN_LENGTH}`);
  }
  return token;
}

function readInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new ConfigError(`${key} must be an integer TCP port between 0 and 65535, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readLogLevel(env: NodeJS.ProcessEnv, key: string, fallback: LogLevel): LogLevel {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new ConfigError(`${key} must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as LogLevel;
}

/**
 * Validate the two tokens together. They must differ: the whole point of having
 * two is that a client token cannot be used on the MCP endpoints.
 */
export function assertTokenPair(clientToken: string, endpointToken: string): void {
  if (clientToken === endpointToken) {
    throw new ConfigError('MCP_PROXY_CLIENT_TOKEN and MCP_PROXY_ENDPOINT_TOKEN must be different tokens');
  }
}

/** Rank of a level, for `>=` comparisons in the logger. */
export function logLevelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/**
 * Build a {@link ProxyConfig} from `env` (default `process.env`).
 *
 * @throws {ConfigError} when a required token is missing or too short, when the
 * two tokens are equal, or when a numeric/level variable is not parseable.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const clientToken = readToken(env, 'MCP_PROXY_CLIENT_TOKEN');
  const endpointToken = readToken(env, 'MCP_PROXY_ENDPOINT_TOKEN');
  assertTokenPair(clientToken, endpointToken);

  const heartbeatIntervalMs = readInteger(env, 'MCP_PROXY_HEARTBEAT_INTERVAL_MS', 15_000);
  const heartbeatTimeoutMs = readInteger(env, 'MCP_PROXY_HEARTBEAT_TIMEOUT_MS', 30_000);
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new ConfigError(
      'MCP_PROXY_HEARTBEAT_TIMEOUT_MS must be greater than MCP_PROXY_HEARTBEAT_INTERVAL_MS ' +
        '(a connection is declared dead before it ever gets a chance to answer a ping)',
    );
  }

  return {
    clientToken,
    endpointToken,
    port: readPort(env, 'MCP_PROXY_PORT', 8_080),
    host: readString(env, 'MCP_PROXY_HOST', '0.0.0.0'),
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    requestTimeoutMs: readInteger(env, 'MCP_PROXY_REQUEST_TIMEOUT_MS', 300_000),
    maxMessageBytes: readInteger(env, 'MCP_PROXY_MAX_MESSAGE_BYTES', 33_554_432),
    sessionIdleTtlMs: readInteger(env, 'MCP_PROXY_SESSION_IDLE_TTL_MS', 604_800_000),
    logLevel: readLogLevel(env, 'MCP_PROXY_LOG_LEVEL', 'info'),
  };
}

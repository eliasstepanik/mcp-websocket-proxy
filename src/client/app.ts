/**
 * The client process body (T6): a validated {@link ClientConfig} in, a running
 * work-PC agent out.
 *
 * One call builds everything the machine needs to expose its local MCP servers:
 *
 * - one {@link LocalMcpServer} per `servers` entry (plus the built-in filesystem
 *   server when `filesystem.enabled`), started **eagerly** and independently: a
 *   child whose command does not exist fails on its own and never keeps the
 *   others from starting — {@link LocalMcpServer} reports the failure, and its
 *   supervisor keeps retrying with backoff in the background.
 * - one {@link TunnelClient} carrying every server over a single outbound socket.
 * - one JSON-line logger: stderr always, plus an optional file that is rotated at
 *   {@link ClientLogConfig.maxBytes} keeping {@link ClientLogConfig.maxBackups}
 *   backups. The configured token is scrubbed from every line, so a value can
 *   never reach a log file even when it is echoed back inside an error message.
 *
 * {@link ClientApp.close} tears the whole thing down in the only safe order:
 * stop dialing first (so no new request can arrive), then stop the children.
 */

import { createRequire } from 'node:module';
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

import { LOG_MAX_BACKUPS, LOG_MAX_BYTES, type ClientConfig, type ClientLogConfig, type ClientServerConfig, type LogLevel } from './config.js';
import { LocalMcpServer, type LocalServerState } from './local-server.js';
import { TunnelClient } from './tunnel-client.js';

/** Reported in `hello.clientVersion`. */
export const CLIENT_VERSION = '0.1.0';

/** Console/file verbosity order, most verbose first (mirrors `config.ts`). */
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function logLevelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** One log record. Only the fields the caller passes are written. */
export interface LogRecord {
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

/** A level-gated JSON logger with an optional rotating file sink. */
export interface ClientLogger {
  (record: LogRecord): void;
}

/**
 * Builds the logger described at the top of this module.
 *
 * `secrets` are literal strings that must never appear in the output (the tunnel
 * token): any occurrence is replaced before the line leaves the process.
 */
export function createLogger(log: ClientLogConfig, secrets: readonly string[] = []): ClientLogger {
  const threshold = logLevelRank(log.level);
  const file = log.file;
  const maxBytes = log.maxBytes > 0 ? log.maxBytes : LOG_MAX_BYTES;
  const maxBackups = Math.max(0, log.maxBackups >= 0 ? log.maxBackups : LOG_MAX_BACKUPS);
  /** Bytes written to the file since it was opened/rotated; `undefined` = unknown, re-stat on demand. */
  let fileSize: number | undefined;

  const scrub = (line: string): string => {
    let out = line;
    for (const secret of secrets) {
      if (secret.length === 0) continue;
      out = out.split(secret).join('[redacted]');
    }
    return out;
  };

  const currentSize = (): number => {
    if (fileSize !== undefined) return fileSize;
    try {
      fileSize = statSync(file as string).size;
    } catch {
      fileSize = 0;
    }
    return fileSize;
  };

  /** `file` -> `file.1` -> ... -> `file.<maxBackups>`; the oldest backup is dropped. */
  const rotate = (): void => {
    const path = file as string;
    for (let index = maxBackups; index >= 1; index -= 1) {
      const from = index === 1 ? path : `${path}.${index - 1}`;
      const to = `${path}.${index}`;
      if (index === maxBackups) {
        try {
          if (existsSync(to)) unlinkSync(to);
        } catch {
          /* a backup we cannot delete must not stop logging */
        }
      }
      try {
        if (existsSync(from)) renameSync(from, to);
      } catch {
        /* rotation is best-effort */
      }
    }
    fileSize = 0;
  };

  return (record: LogRecord): void => {
    if (logLevelRank(record.level) < threshold) return;
    const line = `${scrub(JSON.stringify({ time: new Date().toISOString(), ...record }))}\n`;
    process.stderr.write(line);
    if (!file) return;
    try {
      const incoming = Buffer.byteLength(line, 'utf8');
      if (currentSize() + incoming > maxBytes) rotate();
      appendFileSync(file, line, 'utf8');
      fileSize = (fileSize ?? 0) + incoming;
    } catch {
      // A log file that cannot be written must never take the agent down; the
      // stderr copy above already carries the line.
    }
  };
}

/** What {@link startClientApp} returns. */
export interface ClientApp {
  /** Every local server this agent exposes, keyed by tunnel name. */
  readonly servers: Map<string, LocalMcpServer>;
  readonly tunnel: TunnelClient;
  /** Idempotent: stop the tunnel, then every child. */
  close(): Promise<void>;
}

/**
 * Resolve the filesystem server's stdio entry point. It is a dependency of this
 * package, so it is launched with *this* Node binary rather than through `npx`,
 * which would need network access and a writable npm cache on the work PC.
 */
function filesystemServerPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
}

/** Maps a config entry onto the {@link LocalMcpServer} options for it. */
function localOptions(entry: ClientServerConfig, log: ClientLogger): ConstructorParameters<typeof LocalMcpServer>[0] {
  const env: Record<string, string> = {};
  if (entry.inheritEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  Object.assign(env, entry.env);
  return {
    name: entry.name,
    command: entry.command,
    args: entry.args,
    env,
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    onStderrLine: (line) => log({ level: 'debug', message: 'child stderr', server: entry.name, line }),
    onStateChange: (state: LocalServerState, detail?: string) => {
      log({
        level: state === 'failed' ? 'error' : state === 'backoff' ? 'warn' : 'info',
        message: `local server ${state}`,
        server: entry.name,
        ...(detail !== undefined ? { detail } : {}),
      });
    },
  };
}

/**
 * Start every local server, then the tunnel that exposes them.
 *
 * Children are started concurrently and a failure is logged, not thrown: one
 * broken `command` must not stop the machine from serving everything else.
 *
 * @throws when no local server could be started at all (nothing to expose).
 */
export async function startClientApp(config: ClientConfig): Promise<ClientApp> {
  const log = createLogger(config.log, [config.server.token]);

  const servers = new Map<string, LocalMcpServer>();
  for (const entry of config.servers.values()) {
    servers.set(entry.name, new LocalMcpServer(localOptions(entry, log)));
  }
  if (config.filesystem.enabled) {
    const name = config.filesystem.name;
    servers.set(
      name,
      new LocalMcpServer({
        name,
        command: process.execPath,
        args: [filesystemServerPath(), ...config.filesystem.roots],
        onStderrLine: (line) => log({ level: 'debug', message: 'child stderr', server: name, line }),
        onStateChange: (state) =>
          log({ level: state === 'failed' ? 'error' : state === 'backoff' ? 'warn' : 'info', message: `local server ${state}`, server: name }),
      }),
    );
  }

  log({
    level: 'info',
    message: 'starting',
    clientId: config.clientId,
    url: config.server.url,
    servers: [...servers.keys()],
    version: CLIENT_VERSION,
  });

  // Eager and independent: `allSettled` so a child that cannot spawn (a missing
  // command, a bad cwd) only takes *itself* down. Its supervisor keeps retrying
  // in the background, and the tunnel simply does not advertise it until it is up.
  const results = await Promise.allSettled([...servers.values()].map((server) => server.start()));
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const name = [...servers.keys()][index] ?? '?';
    log({
      level: 'error',
      message: 'local server failed to start',
      server: name,
      detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  });

  if ([...servers.values()].every((server) => !server.available)) {
    for (const server of servers.values()) await server.stop();
    throw new Error('no local server could be started: check the `command` of every entry under `servers`');
  }

  const tunnel = new TunnelClient({
    url: config.server.url,
    token: config.server.token,
    clientId: config.clientId,
    clientVersion: CLIENT_VERSION,
    servers,
  });

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (!closing) {
      log({ level: 'info', message: 'closing' });
      closing = (async (): Promise<void> => {
        // Tunnel first: while it is live a request could still be dispatched to a
        // child we are about to kill.
        tunnel.stop();
        for (const server of servers.values()) await server.stop();
        log({ level: 'info', message: 'closed' });
      })();
    }
    await closing;
  };

  return { servers, tunnel, close };
}

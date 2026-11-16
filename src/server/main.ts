/**
 * The server entry point (T3): environment -> {@link readConfig} -> {@link createApp}
 * -> `listen`, plus graceful shutdown and one JSON log line per request.
 *
 * Everything that decides *what* to do lives in `config.ts` (validation) and
 * `app.ts` (routing and auth); this file only wires them and owns the process:
 *
 * - a bad environment exits with a message naming the offending variable — the
 *   messages come from `config.ts` and never contain a token
 * - `SIGINT`/`SIGTERM` close the app (tunnels and sessions first, then the listener)
 *   and then exit 0, so a supervisor sees a clean stop
 * - logging goes to stdout as JSON lines: `{method, path, status, ms}` per request.
 *   No params, no results, no headers, no tokens — `app.ts` hands over exactly those
 *   four fields, so nothing sensitive is even reachable here.
 *
 * Importing this module has no side effects: the process is only started when it is
 * executed directly (see {@link isMain}), which keeps it unit-testable.
 */

import { fileURLToPath } from 'node:url';

import { createApp, type App } from './app.js';
import { ConfigError, logLevelRank, readConfig, type ProxyConfig } from './config.js';

/** Reported as `welcome.serverVersion` and in `/status`. */
export const SERVER_VERSION = '0.1.0';

export interface RunningServer {
  app: App;
  /** The bound port (useful when the config asked for port 0). */
  port: number;
  /** Idempotent: close the app, remove the signal handlers, then resolve. */
  close(): Promise<void>;
}

/** Writes one JSON line to stdout. */
function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * A level-gated JSON logger. `level` is the threshold from the config; anything less
 * verbose than it is dropped. Only the message and safe extra fields are written.
 */
function createLogger(level: ProxyConfig['logLevel']) {
  return (entry: { level: ProxyConfig['logLevel']; message: string; [key: string]: unknown }): void => {
    if (logLevelRank(entry.level) > logLevelRank(level)) return;
    writeLine(entry);
  };
}

/** Binds the listener; rejects on a listen error (e.g. `EADDRINUSE`). */
function listen(app: App, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    app.httpServer.once('error', onError);
    app.httpServer.listen(port, host, () => {
      app.httpServer.off('error', onError);
      const address = app.httpServer.address();
      resolve(address !== null && typeof address === 'object' ? address.port : port);
    });
  });
}

/**
 * Build the app from `env`, start listening and install the signal handlers.
 *
 * @throws {ConfigError} when the environment is invalid (nothing is listening then).
 */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const config = readConfig(env);
  const log = createLogger(config.logLevel);

  const app = createApp({
    clientToken: config.clientToken,
    endpointToken: config.endpointToken,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBodyBytes: config.maxMessageBytes,
    sessionIdleTtlMs: config.sessionIdleTtlMs,
    serverVersion: SERVER_VERSION,
    onRequest: (entry) => {
      log({
        level: 'info',
        message: 'request',
        method: entry.method,
        path: entry.path,
        status: entry.status,
        ms: Math.round(entry.durationMs * 1000) / 1000,
      });
    },
  });

  const port = await listen(app, config.host, config.port);
  log({ level: 'info', message: 'listening', host: config.host, port });

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (!closing) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      log({ level: 'info', message: 'closing' });
      closing = app.close();
    }
    await closing;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    log({ level: 'info', message: 'signal', signal });
    void close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { app, port, close };
}

/** True when this module is the one Node was asked to run. */
function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return metaUrl === pathToFileURL(entry).href;
  } catch {
    // A worker harness may hand us something that is not a filesystem path at all.
    return false;
  }
}

if (isMain(import.meta.url)) {
  start().catch((error: unknown) => {
    // `ConfigError` messages name the variable, never the value.
    const message = error instanceof Error ? error.message : String(error);
    writeLine({ level: 'error', message, ...(error instanceof ConfigError ? { reason: 'config' } : {}) });
    process.exit(1);
  });
}

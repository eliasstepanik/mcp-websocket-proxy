/**
 * The client entry point (T6): config file -> {@link startClientApp} -> run until
 * a signal arrives.
 *
 * The file location follows the platform convention and can always be overridden:
 *
 * - `--config <path>` (or `MCP_PROXY_CLIENT_CONFIG`)
 * - Windows: `%APPDATA%\mcp-websocket-proxy\config.yaml`
 * - elsewhere: `~/.config/mcp-websocket-proxy/config.yaml`
 *
 * `--check` validates the file and exits without touching the network: every
 * problem `config.ts` found is printed, one per line, and the exit code is 1. That
 * is the operator's tool for "will this file work?", so it must never start a
 * child process or dial out.
 *
 * Otherwise the agent runs until `SIGINT`/`SIGTERM`, then closes the tunnel and
 * the children and exits 0. Logging is JSON lines (see `app.ts`); a config error
 * is printed as a plain message on stderr and exits 1, because a broken file is
 * something a human has to fix.
 *
 * Importing this module has no side effects: the agent only starts when Node was
 * asked to run this file (see {@link isMain}), which keeps it testable.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startClientApp, type ClientApp } from './app.js';
import { ConfigError, checkConfig, loadClientConfig } from './config.js';
import { filesystemServerPath } from './filesystem.js';

export interface ClientCliOptions {
  /** Path of the YAML/JSON config file. */
  configPath: string;
  /** Validate and exit instead of running. */
  check: boolean;
}

/** The platform default: `%APPDATA%\mcp-websocket-proxy\config.yaml` on Windows. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appData = env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'mcp-websocket-proxy', 'config.yaml');
  }
  const xdg = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(xdg, 'mcp-websocket-proxy', 'config.yaml');
}

/** Parse `argv` (without `node` and the script path). Unknown flags are errors. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ClientCliOptions {
  let configPath = env['MCP_PROXY_CLIENT_CONFIG'] ?? defaultConfigPath(env);
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--config needs a path');
      configPath = value;
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      if (configPath === '') throw new Error('--config needs a path');
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      throw new HelpRequested(usage());
    }
    throw new Error(`unknown argument ${JSON.stringify(arg ?? '')}; usage: ${usage()}`);
  }
  return { configPath, check };
}

/** Thrown by `--help`: the message is the usage text, not an error. */
class HelpRequested extends Error {}

function usage(): string {
  return 'mcp-websocket-proxy-client [--config <path>] [--check]';
}

/**
 * Run the CLI. Returns the process exit code; the caller decides whether to
 * `process.exit` (so tests can assert on it).
 */
export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: ClientCliOptions;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${error.message}\n`);
      return 0;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (options.check) {
    const result = checkConfig(options.configPath, env);
    if (result.ok) {
      // `--check` is the install task's gate, so it must also catch a broken
      // built-in filesystem server: the same bin resolution `startClientApp` does,
      // without starting anything.
      try {
        if (loadClientConfig(options.configPath, env).filesystem.enabled) filesystemServerPath();
      } catch (error) {
        process.stderr.write(`config invalid: ${options.configPath}\n`);
        process.stderr.write(`- ${(error as Error).message}\n`);
        return 1;
      }
      process.stdout.write('config ok\n');
      return 0;
    }
    process.stderr.write(`config invalid: ${options.configPath}\n`);
    for (const problem of result.errors) process.stderr.write(`- ${problem}\n`);
    return 1;
  }

  let app: ClientApp | undefined;
  let startupDone = false;
  /** A signal that arrived while `startClientApp` was still running. */
  let pendingSignal: NodeJS.Signals | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = (): void => {
    if (!app) return;
    if (!closing) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      closing = app.close();
    }
    void closing.then(
      () => resolveClosed(),
      () => {
        process.stderr.write('fatal: shutdown failed\n');
        process.exitCode = 1;
        resolveClosed();
      },
    );
  };

  // The agent has no natural end: it runs until a signal, then shuts the tunnel
  // and the children down and exits 0 so a supervisor sees a clean stop.
  const onSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'signal', signal })}\n`);
    if (!startupDone) {
      // Ctrl+C *during* startup: remember it and shut down as soon as the agent
      // exists, so a half-started agent never outlives the terminal that started it.
      pendingSignal = signal;
      return;
    }
    close();
  };
  // Installed before startup begins: a signal that arrives while the children are
  // still being spawned must be caught rather than take the process down with its
  // default disposition, which would leave the children behind.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const config = loadClientConfig(options.configPath, env);
    app = await startClientApp(config);
  } catch (error) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // ConfigError messages name the offending variable, never its value.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${error instanceof ConfigError ? 'config error: ' : 'fatal: '}${message}\n`);
    return 1;
  }

  startupDone = true;
  // A signal that arrived during startup is handled now that there is something to close.
  if (pendingSignal !== undefined) close();
  await closed;
  return process.exitCode === 1 ? 1 : 0;
}

/** True when this module is the one Node was asked to run. */
function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return metaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  void run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${(error as Error).message ?? String(error)}\n`);
      process.exit(1);
    });
}

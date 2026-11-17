/**
 * The built-in filesystem server (T6): the one local server every work PC can
 * expose without the operator installing anything.
 *
 * It is the published `@modelcontextprotocol/server-filesystem`, started as a
 * child of *this* Node binary rather than through `npx`:
 *
 * - `npx` needs network access and a writable npm cache, and on a locked-down
 *   work PC it may not exist at all. The package is a dependency of this one, so
 *   the file is already on disk; we only have to find it.
 * - the path is resolved from the package's own `package.json` `bin` field, so a
 *   future version that moves its entry point keeps working without a change
 *   here (and a package that ships no `bin` fails with a message that says so).
 * - the roots from the config are passed as command-line directories, after a
 *   `--` so a root whose name starts with `-` is still taken as a directory.
 *
 * ## Roots capability (plan D6)
 *
 * The client deliberately does **not** declare the `roots` capability:
 * {@link LocalMcpServer} connects its SDK `Client` with `{ name, version }` only,
 * so the `initialize` result advertises no client capabilities at all. That is
 * what we want here, because the filesystem server treats a client's Roots as an
 * *override*: on a 2025-era connection a client that declares `roots` makes the
 * server fetch `roots/list` and replace the command-line directories with the
 * answer. The config file — not a remote client — must decide which directories
 * are exposed, so the roots channel stays closed and the command-line roots are
 * final.
 *
 * Nothing can hang as a result: the server only asks for roots when the
 * capability is present, and if a future version asked anyway, the SDK client
 * answers an unhandled server-to-client request with a JSON-RPC
 * `MethodNotFound` error instead of leaving it unanswered, and the server logs
 * the failure and keeps its command-line directories.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type { FilesystemServerConfig } from './config.js';
import { LocalMcpServer, type LocalServerState } from './local-server.js';

/** The npm package that provides the built-in filesystem server. */
export const FILESYSTEM_SERVER_PACKAGE = '@modelcontextprotocol/server-filesystem';

/** Optional logging hooks, so `app.ts` keeps ownership of the log format. */
export interface FilesystemServerHooks {
  onStateChange?: ((state: LocalServerState, detail?: string) => void) | undefined;
  onStderrLine?: ((line: string) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Absolute path of the filesystem server's stdio entry point, read from the
 * package's `bin` field.
 *
 * @throws when the package is not installed, declares no `bin`, or the file the
 *         `bin` field names is missing (a half-installed `node_modules`).
 */
export function filesystemServerPath(): string {
  const require = createRequire(import.meta.url);
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${FILESYSTEM_SERVER_PACKAGE}/package.json`);
  } catch {
    throw new Error(
      `the built-in filesystem server needs the package ${FILESYSTEM_SERVER_PACKAGE} installed next to this file; ` +
        'run `npm install`, or set `filesystem.enabled: false` to start without it',
    );
  }

  let bin: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown };
    if (typeof manifest.bin === 'string') bin = manifest.bin;
    else if (isRecord(manifest.bin)) bin = Object.values(manifest.bin).find((value): value is string => typeof value === 'string');
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${(error as Error).message}`);
  }
  if (bin === undefined || bin.trim() === '') {
    throw new Error(`${FILESYSTEM_SERVER_PACKAGE} declares no \`bin\` entry point in ${manifestPath}`);
  }

  const entry = resolve(dirname(manifestPath), bin);
  if (!existsSync(entry)) {
    throw new Error(`${FILESYSTEM_SERVER_PACKAGE} bin ${JSON.stringify(bin)} is missing (${entry}): reinstall the package`);
  }
  return entry;
}

/**
 * Builds the {@link LocalMcpServer} for the built-in filesystem server: the
 * bundled package, run by this Node binary, confined to `cfg.roots`.
 *
 * The caller decides whether to build it at all — `filesystem.enabled: false`
 * means no server is registered (see `app.ts`).
 *
 * @throws when the package cannot be resolved (see {@link filesystemServerPath}).
 */
export function createFilesystemServer(cfg: FilesystemServerConfig, hooks: FilesystemServerHooks = {}): LocalMcpServer {
  return new LocalMcpServer({
    name: cfg.name,
    // This binary, not `npx`: no network, no npm cache, no PATH lookup.
    command: process.execPath,
    // `--` ends the server's own options, so a root that starts with `-` is a
    // directory and not a flag.
    args: [filesystemServerPath(), '--', ...cfg.roots],
    ...(hooks.onStderrLine !== undefined ? { onStderrLine: hooks.onStderrLine } : {}),
    ...(hooks.onStateChange !== undefined ? { onStateChange: hooks.onStateChange } : {}),
  });
}

/**
 * Client configuration (T5): the YAML file the work PC reads at startup.
 *
 * The file is the single source of truth for the client process — the tunnel
 * endpoint, this machine's identity, log settings, the built-in filesystem
 * server and any number of local stdio MCP servers:
 *
 * ```yaml
 * server:
 *   url: wss://host/tunnel
 *   token: ${env:MCP_PROXY_CLIENT_TOKEN}
 *   allowInsecure: false
 * clientId: work-pc
 * log: { level: info, file: 'C:\Users\me\app.log' }
 * filesystem: { enabled: true, roots: ['C:\Users\me\Projects'] }
 * servers:
 *   some-server: { command: npx, args: ['-y', 'some-mcp-server'] }
 * ```
 *
 * Rules enforced here, at startup, so a bad file fails loudly instead of
 * half-working:
 *
 * - `${env:VAR}` is expanded in **every** string value (including the values
 *   inside a server's `env` map). A variable that is not set is an error that
 *   names the variable and never prints a value.
 * - `server.url` must be a `ws://` or `wss://` URL. Plain `ws://` is refused
 *   unless the host is local (`localhost`, `127.0.0.1`, `::1`) or
 *   `server.allowInsecure: true` — the token rides in an upgrade header and
 *   must not cross the network in clear text.
 * - `server.token` must be non-empty. Its length is *not* checked client-side:
 *   the server enforces the real policy, and a client that guessed the floor
 *   would reject valid tokens.
 * - Server names must match {@link SERVER_NAME_RE}. Names are compared
 *   case-insensitively after trimming, so `Files` and `files` are a duplicate,
 *   as is any name that clashes with `filesystem.name`.
 * - There must be at least one server to expose: `servers` may be empty only
 *   when the filesystem server is enabled.
 *
 * {@link loadClientConfig} throws a {@link ConfigError} on the first problem;
 * {@link checkConfig} never throws and returns every problem found, which is
 * what `--check` prints.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parse as parseYaml } from 'yaml';

import { SERVER_NAME_RE } from '../shared/protocol.js';

/** Console/file verbosity, most verbose first (same vocabulary as the server). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** A log file is rotated once it reaches this size. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** How many rotated files to keep next to the active one. */
export const LOG_MAX_BACKUPS = 1;

/** Name the built-in filesystem server publishes under by default. */
export const DEFAULT_FILESYSTEM_SERVER_NAME = 'filesystem';

/**
 * Hosts a plain `ws://` URL may point at. Anything else must use `ws
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
 *   some-server: { command: npx, args: ['-y', 'some-mcp-server'], env: { API_KEY: '${env:SOME_KEY}' } }
 * ```
 *
 * The rules are enforced here, at startup, so a bad file fails loudly instead of
 * half-working:
 *
 * - `${env:VAR}` is expanded in **every** string value, including the values
 *   inside a server's `env` map. A variable that is not set is an error naming
 *   the variable; values are never printed.
 * - `server.url` must be a `ws://` or `wss://` URL. Plain `ws://` is refused
 *   unless the host is local ({@link LOCAL_HOSTS}) or `server.allowInsecure` is
 *   true: the token travels in an upgrade header and must not cross a network in
 *   clear text.
 * - `server.token` must be non-empty. Its length is deliberately *not* checked
 *   client-side — the server enforces the real policy, and a client-side guess
 *   would reject valid tokens.
 * - Server names must match {@link SERVER_NAME_RE}. Names are compared after
 *   {@link normalizeServerName}, so `Files` and `files` collide, and so does any
 *   name that collides with `filesystem.name`.
 * - There must be at least one server to expose: `servers` may be empty only
 *   when the filesystem server is enabled.
 *
 * {@link loadClientConfig} throws a {@link ConfigError}; {@link checkConfig}
 * never throws and reports *every* problem it finds, which is what `--check`
 * prints.
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

/** How many rotated files are kept next to the active one. */
export const LOG_MAX_BACKUPS = 1;

/** Name the built-in filesystem server publishes under unless overridden. */
export const DEFAULT_FILESYSTEM_SERVER_NAME = 'filesystem';

/** Hosts a plain `ws://` URL may point at without `allowInsecure`. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `${env:VAR}` — a shell-style placeholder, usable anywhere inside a string. */
const ENV_PLACEHOLDER_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Raised for a bad config file. The message never contains a secret value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** One local stdio MCP server, as it will be handed to `LocalMcpServer`. */
export interface ClientServerConfig {
  /** Tunnel name (validated against {@link SERVER_NAME_RE}). */
  name: string;
  command: string;
  args: string[];
  /** Already `${env:...}`-expanded environment for the child. */
  env: Record<string, string>;
  cwd?: string | undefined;
  /** Start the child with `process.env` plus {@link env}. Default false. */
  inheritEnv: boolean;
}

/** The built-in filesystem server (parsed and validated here; wired up in T6). */
export interface FilesystemServerConfig {
  enabled: boolean;
  /** Tunnel name it publishes under. */
  name: string;
  /** Absolute roots it may serve; required when enabled. */
  roots: string[];
}

/** Log settings, including the rotation policy the file sink must apply. */
export interface ClientLogConfig {
  level: LogLevel;
  /** Optional log file; when absent only the console is written. */
  file?: string | undefined;
  /** Rotation size in bytes ({@link LOG_MAX_BYTES}). */
  maxBytes: number;
  /** Rotated files to keep ({@link LOG_MAX_BACKUPS}). */
  maxBackups: number;
}

/** A fully validated client configuration. */
export interface ClientConfig {
  server: {
    /** Tunnel endpoint, e.g. `wss://warren.example.com/tunnel`. */
    url: string;
    /** Bearer token for the upgrade request (expanded, non-empty). */
    token: string;
    /** Whether a plain `ws://` endpoint is accepted. */
    allowInsecure: boolean;
  };
  /** Identity sent in `hello`; defaults to `os.hostname()`. */
  clientId: string;
  log: ClientLogConfig;
  filesystem: FilesystemServerConfig;
  /** Local stdio servers, keyed by tunnel name (excludes the filesystem server). */
  servers: Map<string, ClientServerConfig>;
}

/** Result of {@link checkConfig}: never throws, lists every problem. */
export interface ConfigCheck {
  ok: boolean;
  errors: string[];
}

/** Names are compared case-insensitively and trimmed, so `Files` == `files`. */
export function normalizeServerName(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// ${env:VAR} expansion
// ---------------------------------------------------------------------------

/**
 * Replace every `${env:VAR}` in `value`.
 *
 * @param errors problems are appended, never thrown: `--check` must report all
 *               of them at once. The placeholder is left out of the result so
 *               validation can keep going with the remaining fields.
 */
function expandString(value: string, env: NodeJS.ProcessEnv, errors: string[], where: string): string {
  return value.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => {
    const raw = env[name];
    if (raw === undefined) {
      // The variable name is the actionable part; the value does not exist, and
      // no other value is ever echoed.
      errors.push(`${where}: environment variable ${name} is not set`);
      return '';
    }
    return raw;
  });
}

/** Deep-walk a parsed document and expand every string value (keys are literal). */
function expandValue(value: unknown, env: NodeJS.ProcessEnv, errors: string[], where: string): unknown {
  if (typeof value === 'string') return expandString(value, env, errors, where);
  if (Array.isArray(value)) return value.map((item, index) => expandValue(item, env, errors, `${where}[${index}]`));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandValue(item, env, errors, where ? `${where}.${key}` : key);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field helpers (each pushes a message instead of throwing)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  where: string,
  errors: string[],
  options: { required?: boolean; default?: string } = {},
): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (options.required) errors.push(`${where}.${key} is required`);
    return options.default;
  }
  if (typeof raw !== 'string') {
    errors.push(`${where}.${key} must be a string`);
    return options.default;
  }
  if (raw.trim() === '' && options.required) {
    errors.push(`${where}.${key} must not be empty`);
    return options.default;
  }
  return raw;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  where: string,
  errors: string[],
  fallback: boolean,
): boolean {
  const raw = source[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    errors.push(`${where}.${key} must be true or false`);
    return fallback;
  }
  return raw;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  where: string,
  errors: string[],
): string[] {
  const raw = source[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${where}.${key} must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push(`${where}.${key}[${index}] must be a string`);
      return;
    }
    out.push(item);
  });
  return out;
}

function readStringMap(
  source: Record<string, unknown>,
  key: string,
  where: string,
  errors: string[],
): Record<string, string> {
  const raw = source[key];
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    errors.push(`${where}.${key} must be a map of string keys to string values`);
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      errors.push(`${where}.${key}.${name} must be a string`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Optional sub-object: absent means `{}`, present must be a map. */
function readSection(root: Record<string, unknown>, key: string, errors: string[]): Record<string, unknown> {
  const raw = root[key];
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    errors.push(`${key} must be a map`);
    return {};
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** `ws://` is only safe on a host the token never has to cross. */
function validateUrl(url: string, allowInsecure: boolean, errors: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`server.url is not a valid URL: ${JSON.stringify(url)}`);
    return;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    errors.push(`server.url must start with ws:// or wss://, got ${JSON.stringify(parsed.protocol)}`);
    return;
  }
  if (parsed.protocol === 'ws:' && !allowInsecure) {
    const host = parsed.hostname;
    if (!LOCAL_HOSTS.has(host)) {
      errors.push(
        `server.url uses unencrypted ws:// for host ${JSON.stringify(host)}: use wss://, or set server.allowInsecure: true ` +
          'only on a trusted network',
      );
    }
  }
}

function parseServerSection(root: Record<string, unknown>, errors: string[]): ClientConfig['server'] {
  const section = readSection(root, 'server', errors);
  const url = readString(section, 'url', 'server', errors, { required: true }) ?? '';
  const token = readString(section, 'token', 'server', errors, { required: true }) ?? '';
  const allowInsecure = readBoolean(section, 'allowInsecure', 'server', errors, false);
  if (url.trim() === '' && !errors.some((e) => e.startsWith('server.url'))) {
    errors.push('server.url is required');
  }
  if (url) validateUrl(url.trim(), allowInsecure, errors);
  if (token.trim() === '' && !errors.some((e) => e.startsWith('server.token'))) {
    // Length is the server's business; the client only needs *a* token.
    errors.push('server.token is required: set it (usually as ${env:MCP_PROXY_CLIENT_TOKEN})');
  }
  return { url: url.trim(), token, allowInsecure };
}

function parseLogSection(root: Record<string, unknown>, errors: string[]): ClientLogConfig {
  const section = readSection(root, 'log', errors);
  const rawLevel = readString(section, 'level', 'log', errors, { default: 'info' }) ?? 'info';
  const level = rawLevel.trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    errors.push(`log.level must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(rawLevel)}`);
  }
  const file = readString(section, 'file', 'log', errors);
  return {
    level: (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : 'info',
    ...(file !== undefined && file.trim() !== '' ? { file: file.trim() } : {}),
    maxBytes: LOG_MAX_BYTES,
    maxBackups: LOG_MAX_BACKUPS,
  };
}

function parseFilesystemSection(root: Record<string, unknown>, errors: string[]): FilesystemServerConfig {
  const section = readSection(root, 'filesystem', errors);
  const enabled = readBoolean(section, 'enabled', 'filesystem', errors, true);
  const name = (readString(section, 'name', 'filesystem', errors, { default: DEFAULT_FILESYSTEM_SERVER_NAME }) ??
    DEFAULT_FILESYSTEM_SERVER_NAME).trim();
  const roots = readStringArray(section, 'roots', 'filesystem', errors);
  if (enabled && roots.length === 0) {
    errors.push('filesystem.roots is required when the filesystem server is enabled');
  }
  return { enabled, name, roots };
}

function parseServersSection(root: Record<string, unknown>, errors: string[]): Map<string, ClientServerConfig> {
  const servers = new Map<string, ClientServerConfig>();
  const section = root['servers'];
  if (section !== undefined && section !== null && !isRecord(section)) {
    errors.push('servers must be a map of server name to server settings');
    return servers;
  }
  for (const [key, value] of Object.entries(section ?? {})) {
    const where = `servers.${key}`;
    if (!isRecord(value)) {
      errors.push(`${where} must be a map with at least a \`command\``);
      continue;
    }
    const name = normalizeServerName(key);
    if (!SERVER_NAME_RE.test(name)) {
      errors.push(
        `invalid server name ${JSON.stringify(key)}: must match ${SERVER_NAME_RE} (lowercase letters, digits, '_' and '-', max 63 characters)`,
      );
    }
    if (servers.has(name)) {
      errors.push(`duplicate server name ${JSON.stringify(name)}: server names must be unique after trimming and lowercasing`);
      continue;
    }
    const command = readString(value, 'command', where, errors, { required: true }) ?? '';
    servers.set(name, {
      name,
      command: command.trim(),
      args: readStringArray(value, 'args', where, errors),
      env: readStringMap(value, 'env', where, errors),
      ...(readString(value, 'cwd', where, errors)?.trim() ? { cwd: readString(value, 'cwd', where, errors)!.trim() } : {}),
      inheritEnv: readBoolean(value, 'inheritEnv', where, errors, false),
    });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse, expand and validate the *text* of a config file. Never throws. */
export function checkConfigText(text: string, env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return { ok: false, errors: [`config is not valid YAML or JSON: ${(error as Error).message}`] };
  }
  if (document === null || document === undefined) {
    return { ok: false, errors: ['config file is empty'] };
  }
  if (!isRecord(document)) {
    return { ok: false, errors: ['config must be a map of settings'] };
  }

  const errors: string[] = [];
  const expanded = expandValue(document, env, errors, '') as Record<string, unknown>;

  const server = parseServerSection(expanded, errors);
  const rawClientId = readString(expanded, 'clientId', '', errors);
  const clientId = rawClientId?.trim() ? rawClientId.trim() : hostname();
  const log = parseLogSection(expanded, errors);
  const filesystem = parseFilesystemSection(expanded, errors);
  const servers = parseServersSection(expanded, errors);

  if (filesystem.enabled && servers.has(normalizeServerName(filesystem.name))) {
    errors.push(
      `server name ${JSON.stringify(filesystem.name)} is already used by the filesystem server: rename it or one of the servers`,
    );
  }
  if (servers.size === 0 && !filesystem.enabled) {
    errors.push('config exposes no servers: add an entry under `servers` or enable the filesystem server');
  }

  const config: ClientConfig = {
    server,
    clientId,
    log,
    filesystem,
    servers,
  };
  return { ok: errors.length === 0, errors, ...(errors.length === 0 ? { config } : {}) } as ConfigCheck & {
    config: ClientConfig;
  };
}

/**
 * Read and validate `path`.
 *
 * @throws {ConfigError} when the file cannot be read, is not valid YAML/JSON, or
 *         fails any rule described at the top of this module. The message lists
 *         every problem found and never a secret value.
 */
export function loadClientConfig(path: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config file ${path}: ${(error as Error).message}`);
  }

  const check = checkConfigText(text, env) as ConfigCheck & { config?: ClientConfig };
  if (!check.ok || !check.config) {
    throw new ConfigError(`${path}: ${check.errors.join('; ')}`);
  }
  return check.config;
}

/**
 * Validate `path` for `--check`: reports every problem instead of throwing.
 */
export function checkConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`cannot read config file ${path}: ${(error as Error).message}`] };
  }
  const check = checkConfigText(text, env) as ConfigCheck & { config?: ClientConfig };
  return { ok: check.ok, errors: check.errors };
}

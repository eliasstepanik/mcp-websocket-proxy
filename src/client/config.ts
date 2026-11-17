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
 *   some-http-server: { url: 'http://127.0.0.1:12306/mcp', headers: { Authorization: 'Bearer ${env:KEY}' } }
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
 * - A server entry has exactly one of `command` (a stdio child) or `url` (a
 *   Streamable HTTP server already running on this machine). `url` must be
 *   `http://` or `https://`; plain `http://` is refused for a non-local host
 *   unless the entry sets `allowInsecure: true`.
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

/** One local MCP server (stdio child or HTTP endpoint), as it will be handed to `LocalMcpServer`. */
export interface ClientServerConfig {
  /** Tunnel name (validated against {@link SERVER_NAME_RE}). */
  name: string;
  /** Stdio child command; empty for a {@link url} server. */
  command: string;
  /** Streamable HTTP endpoint; set instead of {@link command}. */
  url?: string | undefined;
  /** HTTP headers sent to {@link url} (already `${env:...}`-expanded). */
  headers?: Record<string, string> | undefined;
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
  /** Roots it may serve; required when enabled. */
  roots: string[];
}

/** Log settings, including the rotation policy the file sink must apply. */
export interface ClientLogConfig {
  level: LogLevel;
  /** Optional log file; when absent only the console is written. */
  file?: string | undefined;
  /** Rotate once the file reaches this size in bytes ({@link LOG_MAX_BYTES}). */
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
  /** Local stdio servers, keyed by tunnel name (the filesystem server is separate). */
  servers: Map<string, ClientServerConfig>;
}

/** Result of {@link checkConfig}: never throws, lists every problem. */
export interface ConfigCheck {
  ok: boolean;
  errors: string[];
  /** The parsed configuration, present only when `ok`. */
  config?: ClientConfig;
}

/** Names are compared case-insensitively and trimmed, so `Files` == `files`. */
export function normalizeServerName(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// ${env:VAR} expansion
// ---------------------------------------------------------------------------

/**
 * Replace every `${env:VAR}` in `value`. A missing variable is reported through
 * `errors` (so `--check` can list all problems at once) and expands to `''`.
 */
function expandString(value: string, env: NodeJS.ProcessEnv, errors: string[], where: string): string {
  return value.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => {
    const raw = env[name];
    if (raw === undefined) {
      // The variable name is the actionable part; no value is ever echoed.
      errors.push(`${where}: environment variable ${name} is not set`);
      return '';
    }
    return raw;
  });
}

/** Deep-walk a parsed document and expand every string value (keys stay literal). */
function expandValue(value: unknown, env: NodeJS.ProcessEnv, errors: string[], where: string): unknown {
  if (typeof value === 'string') return expandString(value, env, errors, where || 'config');
  if (Array.isArray(value)) return value.map((item, index) => expandValue(item, env, errors, `${where}[${index}]`));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = expandValue(item, env, errors, where ? `${where}.${key}` : key);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field helpers (each reports a problem instead of throwing)
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
  const path = where ? `${where}.${key}` : key;
  if (raw === undefined || raw === null) {
    if (options.required) errors.push(`${path} is required`);
    return options.default;
  }
  if (typeof raw !== 'string') {
    errors.push(`${path} must be a string`);
    return options.default;
  }
  if (options.required && raw.trim() === '') {
    errors.push(`${path} must not be empty`);
    return options.default;
  }
  return raw;
}

function readBoolean(source: Record<string, unknown>, key: string, where: string, errors: string[], fallback: boolean): boolean {
  const raw = source[key];
  const path = where ? `${where}.${key}` : key;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    errors.push(`${path} must be true or false`);
    return fallback;
  }
  return raw;
}

function readStringArray(source: Record<string, unknown>, key: string, where: string, errors: string[]): string[] {
  const raw = source[key];
  const path = where ? `${where}.${key}` : key;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path} must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push(`${path}[${index}] must be a string`);
      return;
    }
    out.push(item);
  });
  return out;
}

function readStringMap(source: Record<string, unknown>, key: string, where: string, errors: string[]): Record<string, string> {
  const raw = source[key];
  const path = where ? `${where}.${key}` : key;
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    errors.push(`${path} must be a map of names to string values`);
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      errors.push(`${path}.${name} must be a string`);
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

/** The text at `path` in the *unexpanded* document, when it is a string. */
function rawStringAt(root: Record<string, unknown>, ...path: string[]): string | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * The first line of a `yaml` library error.
 *
 * The library appends the offending source line and a caret to its message; the
 * file may hold a literal secret on exactly that line, so only the problem and
 * its position are kept.
 */
function yamlErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0]?.trim() || message;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Plain `ws://` is only acceptable for a host the token never has to cross. */
function validateUrl(url: string, allowInsecure: boolean, errors: string[], display?: string): void {
  // What the message prints: the text from the file, never the expanded value
  // (which may be a secret pulled in through `${env:...}`).
  const shown = display ?? url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`server.url is not a valid URL: ${JSON.stringify(shown)}`);
    return;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    errors.push(`server.url must start with ws:// or wss://, got ${JSON.stringify(shown)}`);
    return;
  }
  if (parsed.protocol === 'ws:' && !allowInsecure && !LOCAL_HOSTS.has(parsed.hostname)) {
    // The host is only named when it was literally in the file: if the URL came
    // from `${env:...}` the expanded host is a value and stays unprinted.
    const host = display === undefined || display === url ? parsed.hostname : shown;
    errors.push(
      `server.url uses unencrypted ws:// for host ${JSON.stringify(host)}: use wss://, or set ` +
        'server.allowInsecure: true only on a network you trust',
    );
  }
}

/** A `url` server: http(s) only, and plain http only for a local host unless allowed. */
function validateHttpUrl(url: string, allowInsecure: boolean, where: string, errors: string[], display?: string): void {
  const shown = display ?? url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`${where}.url is not a valid URL: ${JSON.stringify(shown)}`);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push(`${where}.url must start with http:// or https://, got ${JSON.stringify(shown)}`);
    return;
  }
  if (parsed.protocol === 'http:' && !allowInsecure && !LOCAL_HOSTS.has(parsed.hostname)) {
    const host = display === undefined || display === url ? parsed.hostname : shown;
    errors.push(
      `${where}.url uses unencrypted http:// for host ${JSON.stringify(host)}: use https://, or set ` +
        `${where}.allowInsecure: true only on a network you trust`,
    );
  }
}

function parseServerSection(root: Record<string, unknown>, errors: string[], rawRoot: Record<string, unknown>): ClientConfig['server'] {
  const section = readSection(root, 'server', errors);
  const url = readString(section, 'url', 'server', errors, { required: true }) ?? '';
  // Only non-empty is required: token length is the server's policy, and a
  // client-side guess would reject valid tokens.
  const token = readString(section, 'token', 'server', errors, { required: true }) ?? '';
  const allowInsecure = readBoolean(section, 'allowInsecure', 'server', errors, false);
  if (url.trim()) validateUrl(url.trim(), allowInsecure, errors, rawStringAt(rawRoot, 'server', 'url'));
  return { url: url.trim(), token, allowInsecure };
}

function parseLogSection(root: Record<string, unknown>, errors: string[], rawRoot: Record<string, unknown>): ClientLogConfig {
  const section = readSection(root, 'log', errors);
  const rawLevel = readString(section, 'level', 'log', errors, { default: 'info' }) ?? 'info';
  const level = rawLevel.trim().toLowerCase();
  const known = (LOG_LEVELS as readonly string[]).includes(level);
  if (!known) {
    errors.push(
      `log.level must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(rawStringAt(rawRoot, 'log', 'level') ?? rawLevel)}`,
    );
  }
  const file = readString(section, 'file', 'log', errors);
  return {
    level: (known ? level : 'info') as LogLevel,
    ...(file !== undefined && file.trim() !== '' ? { file: file.trim() } : {}),
    maxBytes: LOG_MAX_BYTES,
    maxBackups: LOG_MAX_BACKUPS,
  };
}

function parseFilesystemSection(root: Record<string, unknown>, errors: string[], rawRoot: Record<string, unknown>): FilesystemServerConfig {
  const section = readSection(root, 'filesystem', errors);
  const enabled = readBoolean(section, 'enabled', 'filesystem', errors, true);
  const rawName = readString(section, 'name', 'filesystem', errors);
  const name = rawName?.trim() ? rawName.trim() : DEFAULT_FILESYSTEM_SERVER_NAME;
  if (!SERVER_NAME_RE.test(name)) {
    errors.push(
      `invalid server name ${JSON.stringify(rawStringAt(rawRoot, 'filesystem', 'name') ?? rawName)}: filesystem.name must match ${SERVER_NAME_RE}`,
    );
  }
  const roots = readStringArray(section, 'roots', 'filesystem', errors);
  if (enabled && roots.length === 0) {
    errors.push('filesystem.roots is required when the filesystem server is enabled');
  }
  return { enabled, name, roots };
}

function parseServersSection(root: Record<string, unknown>, errors: string[], rawRoot: Record<string, unknown>): Map<string, ClientServerConfig> {
  const servers = new Map<string, ClientServerConfig>();
  const section = root['servers'];
  if (section !== undefined && section !== null && !isRecord(section)) {
    errors.push('servers must be a map of server name to server settings');
    return servers;
  }
  for (const [key, value] of Object.entries(section ?? {})) {
    const where = `servers.${key}`;
    if (!isRecord(value)) {
      errors.push(`${where} must be a map with a \`command\` or a \`url\``);
      continue;
    }
    const name = normalizeServerName(key);
    // The raw key is checked: `Files` is not a legal name even though it would
    // normalise to one, and saying so is clearer than silently renaming it.
    if (!SERVER_NAME_RE.test(key)) {
      errors.push(
        `invalid server name ${JSON.stringify(key)}: must match ${SERVER_NAME_RE} ` +
          '(lowercase letters, digits, "_" and "-", at most 63 characters)',
      );
    }
    if (servers.has(name)) {
      errors.push(`duplicate server name ${JSON.stringify(name)}: names must be unique after trimming and lowercasing`);
      continue;
    }
    const hasUrl = value['url'] !== undefined && value['url'] !== null;
    const hasCommand = value['command'] !== undefined && value['command'] !== null;
    if (hasUrl && hasCommand) {
      errors.push(`${where} must set either \`command\` or \`url\`, not both`);
      continue;
    }
    if (hasUrl) {
      const url = (readString(value, 'url', where, errors, { required: true }) ?? '').trim();
      const allowInsecure = readBoolean(value, 'allowInsecure', where, errors, false);
      if (url) validateHttpUrl(url, allowInsecure, where, errors, rawStringAt(rawRoot, 'servers', key, 'url'));
      servers.set(name, {
        name,
        command: '',
        url,
        headers: readStringMap(value, 'headers', where, errors),
        args: [],
        env: {},
        inheritEnv: false,
      });
      continue;
    }
    const command = readString(value, 'command', where, errors, { required: true }) ?? '';
    const cwd = readString(value, 'cwd', where, errors)?.trim();
    servers.set(name, {
      name,
      command: command.trim(),
      args: readStringArray(value, 'args', where, errors),
      env: readStringMap(value, 'env', where, errors),
      ...(cwd ? { cwd } : {}),
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
    return { ok: false, errors: [`config is not valid YAML or JSON: ${yamlErrorLine(error)}`] };
  }
  if (document === null || document === undefined) return { ok: false, errors: ['config file is empty'] };
  if (!isRecord(document)) return { ok: false, errors: ['config must be a map of settings'] };

  const errors: string[] = [];
  // `document` is kept as the *pre-expansion* document: error messages quote this
  // text, never the expanded one, so a value pulled in through `${env:VAR}` can
  // never be echoed.
  const raw = document;
  const expanded = expandValue(document, env, errors, '') as Record<string, unknown>;

  const server = parseServerSection(expanded, errors, raw);
  const rawClientId = readString(expanded, 'clientId', '', errors);
  const clientId = rawClientId?.trim() ? rawClientId.trim() : hostname();
  const log = parseLogSection(expanded, errors, raw);
  const filesystem = parseFilesystemSection(expanded, errors, raw);
  const servers = parseServersSection(expanded, errors, raw);

  if (filesystem.enabled && servers.has(normalizeServerName(filesystem.name))) {
    errors.push(
      `server name ${JSON.stringify(filesystem.name)} is already used by the filesystem server: rename it or the colliding server`,
    );
  }
  if (servers.size === 0 && !filesystem.enabled) {
    errors.push('config exposes no servers: add an entry under `servers` or enable the filesystem server');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], config: { server, clientId, log, filesystem, servers } };
}

/**
 * Read and validate `path`.
 *
 * @throws {ConfigError} when the file cannot be read, is not valid YAML/JSON or
 *         fails any rule described at the top of this module. The message lists
 *         every problem found and never a secret value.
 */
export function loadClientConfig(path: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const check = checkPath(path, env);
  if (!check.ok || !check.config) throw new ConfigError(`${path}: ${check.errors.join('; ')}`);
  return check.config;
}

/** Validate `path` for `--check`: reports every problem instead of throwing. */
export function checkConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  const check = checkPath(path, env);
  return { ok: check.ok, errors: check.errors };
}

function checkPath(path: string, env: NodeJS.ProcessEnv): ConfigCheck {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`cannot read config file ${path}: ${(error as Error).message}`] };
  }
  return checkConfigText(text, env);
}

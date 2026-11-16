/**
 * Wraps an SDK `Client` + `StdioClientTransport` around a local stdio MCP server and
 * exposes it as an {@link Upstream}.
 *
 * This is what runs on the Windows work PC (T1: directly; T2: behind the WebSocket
 * tunnel). It owns the child process lifecycle:
 *
 * - `start()` spawns the child, performs the MCP `initialize` handshake and caches
 *   the result as {@link LocalMcpServer.info}.
 * - stderr is captured line-by-line and prefixed with the server name so logs from
 *   several children stay attributable.
 * - if the child dies unexpectedly it is restarted with exponential backoff (unless
 *   `restart: false`), and `onStateChange` fires so the tunnel can fail in-flight
 *   requests with `server_down`.
 *
 * Intercepting upstream notifications: `Protocol` takes ownership of
 * `transport.onmessage` in `connect()`, but it *preserves and calls* a handler that
 * was already installed. So we install ours on the transport before `connect()` and
 * get a copy of every inbound JSON-RPC message without disturbing the SDK.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type Notification,
  type Request,
  ResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { Upstream, UpstreamInfo, UpstreamNotificationListener, UpstreamRequestOptions } from '../shared/upstream.js';
import { proxyError, toRelayableError } from '../shared/errors.js';

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed';

export interface LocalServerOptions {
  /** Server name; must match `^[a-z0-9][a-z0-9_-]{0,62}$`. */
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  /** Restart the child automatically when it exits unexpectedly. Default true. */
  restart?: boolean | undefined;
  /** Backoff schedule in ms; the last entry repeats. Default `[250, 500, 1000, 2000, 5000, 10000]`. */
  restartDelays?: number[] | undefined;
  /** Give up after this many consecutive failed restarts. Default Infinity. */
  maxRestarts?: number | undefined;
  /** Per-request timeout in ms passed to the SDK client. Default 60000. */
  requestTimeoutMs?: number | undefined;
  /** Called on every state change. */
  onStateChange?: ((state: LocalServerState, detail?: string) => void) | undefined;
  /** Called with each prefixed stderr line. Defaults to `process.stderr.write`. */
  onStderrLine?: ((line: string) => void) | undefined;
}

const DEFAULT_RESTART_DELAYS = [250, 500, 1000, 2000, 5000, 10000];
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class LocalMcpServer implements Upstream {
  readonly name: string;

  private readonly options: LocalServerOptions;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private cachedInfo: UpstreamInfo | undefined;
  private state: LocalServerState = 'stopped';
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly listeners = new Set<UpstreamNotificationListener>();
  private stderrBuffer = '';

  constructor(options: LocalServerOptions) {
    this.options = options;
    this.name = options.name;
  }

  get currentState(): LocalServerState {
    return this.state;
  }

  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  get available(): boolean {
    return this.state === 'running' && this.client !== undefined;
  }

  /** Cached `initialize` result of the child process. */
  get info(): UpstreamInfo {
    if (!this.cachedInfo) {
      throw proxyError('server_down', `local server "${this.name}" has not initialised yet`);
    }
    return this.cachedInfo;
  }

  /** Spawn the child and complete the `initialize` handshake. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.spawn();
  }

  /** Stop the child and do not restart it. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.setState('stopped');
    await client?.close().catch(() => undefined);
  }

  async request(method: string, params?: unknown, options?: UpstreamRequestOptions): Promise<unknown> {
    const client = this.client;
    if (!client || this.state !== 'running') {
      throw proxyError('server_down', `local server "${this.name}" is not running`);
    }

    const requestOptions: Parameters<Client['request']>[2] = {
      timeout: options?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
    if (options?.signal) requestOptions.signal = options.signal;
    if (options?.onProgress) {
      requestOptions.onprogress = (progress) => options.onProgress?.(progress as Record<string, unknown>);
    }

    try {
      return await client.request({ method, ...(params !== undefined ? { params } : {}) } as Request, ResultSchema, requestOptions);
    } catch (error) {
      throw toRelayableError(error);
    }
  }

  async notification(method: string, params?: unknown): Promise<void> {
    const client = this.client;
    if (!client || this.state !== 'running') {
      throw proxyError('server_down', `local server "${this.name}" is not running`);
    }
    await client.notification({ method, ...(params !== undefined ? { params } : {}) } as Notification);
  }

  subscribe(listener: UpstreamNotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------------ internals

  private async spawn(): Promise<void> {
    this.setState('starting');

    const transport = new StdioClientTransport({
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      env: this.options.env ?? getDefaultEnvironment(),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stderr: 'pipe',
    });

    const client = new Client({ name: 'mcp-websocket-proxy-client', version: '0.1.0' });

    transport.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));

    // Snapshot of the initialise result, captured off the wire so we can report the
    // protocol version the child actually negotiated.
    let negotiatedProtocolVersion: string | undefined;

    transport.onmessage = (message) => {
      if (isJSONRPCResultResponse(message)) {
        const result = message.result as { protocolVersion?: unknown } | undefined;
        if (result && typeof result.protocolVersion === 'string') {
          negotiatedProtocolVersion = result.protocolVersion;
        }
        return;
      }
      if (isJSONRPCNotification(message)) {
        // Progress belongs to a specific in-flight request and is delivered by the
        // SDK to that request's `onprogress` callback; don't double-deliver it.
        if (message.method === 'notifications/progress') return;
        const params = message.params;
        for (const listener of this.listeners) {
          try {
            listener({ method: message.method, ...(params !== undefined ? { params } : {}) });
          } catch {
            /* one bad listener must never break the relay */
          }
        }
      }
    };

    client.onclose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.transport = undefined;
      this.handleUnexpectedExit();
    };
    client.onerror = () => {
      /* Transport-level noise (unknown progress tokens, unknown message ids) is not fatal here. */
    };

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      this.cachedInfo = undefined;
      this.handleUnexpectedExit((error as Error).message);
      throw proxyError('server_down', `local server "${this.name}" failed to start: ${(error as Error).message}`);
    }

    this.client = client;
    this.transport = transport;
    this.cachedInfo = {
      protocolVersion: negotiatedProtocolVersion ?? '2025-06-18',
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? { name: this.name, version: '0.0.0' },
      ...(client.getInstructions() !== undefined ? { instructions: client.getInstructions() } : {}),
    };
    this.restartAttempt = 0;
    this.setState('running');
  }

  private handleUnexpectedExit(detail?: string): void {
    if (this.stopping) {
      this.setState('stopped', detail);
      return;
    }
    if (this.options.restart === false) {
      this.setState('failed', detail ?? 'child exited');
      return;
    }
    const maxRestarts = this.options.maxRestarts ?? Number.POSITIVE_INFINITY;
    if (this.restartAttempt >= maxRestarts) {
      this.setState('failed', detail ?? 'child exited');
      return;
    }
    const delays = this.options.restartDelays ?? DEFAULT_RESTART_DELAYS;
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)] ?? 0;
    this.restartAttempt += 1;
    this.setState('backoff', detail ?? 'child exited');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawn().catch(() => undefined);
    }, delay);
    this.restartTimer.unref?.();
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');
    const lines = this.stderrBuffer.split('\n');
    this.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const prefixed = line.startsWith(`[${this.name}:`) ? line : `[${this.name}:pid=${this.transport?.pid ?? '?'}] ${line}`;
      if (this.options.onStderrLine) this.options.onStderrLine(prefixed);
      else process.stderr.write(`${prefixed}\n`);
    }
  }

  private setState(state: LocalServerState, detail?: string): void {
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}

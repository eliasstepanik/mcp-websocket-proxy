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
 *   `restart: false`), and `onStateChange` fires so the tunnel can tell the server
 *   to fail in-flight requests with `server_down`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError, ResultSchema, type InitializeResult } from '@modelcontextprotocol/sdk/types.js';

import type { Upstream, UpstreamInfo, UpstreamNotificationListener, UpstreamRequestOptions } from '../shared/upstream.js';
import { proxyError, toRelayableError } from '../shared/errors.js';

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed';

export interface LocalServerOptions {
  /** Server name; must match `^[a-z0-9][a-z0-9_-]{0,62}$`. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Restart the child automatically when it exits unexpectedly. Default true. */
  restart?: boolean;
  /** Backoff schedule in ms; the last entry repeats. Default `[250, 500, 1000, 2000, 5000, 10000]`. */
  restartDelays?: number[];
  /** Give up after this many consecutive failed restarts. Default Infinity. */
  maxRestarts?: number;
  /** Per-request timeout in ms passed to the SDK client. Default 60000. */
  requestTimeoutMs?: number;
  /** Called on every state change (also on every successful (re)initialisation). */
  onStateChange?: (state: LocalServerState, detail?: string) => void;
  /** Called with each prefixed stderr line. Defaults to `process.stderr.write`. */
  onStderrLine?: (line: string) => void;
}

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

    const requestOptions: { signal?: AbortSignal; timeout?: number; onprogress?: (p: { progress: number; total?: number; message?: string }) => void } = {};
    if (options?.signal) requestOptions.signal = options.signal;
    requestOptions.timeout = options?.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    if (options?.onProgress) {
      requestOptions.onprogress = (progress) => options.onProgress?.(progress as Record<string, unknown>);
    }

    try {
      return await client.request({ method, ...(params !== undefined ? { params } : {}) }, ResultSchema, requestOptions);
    } catch (error) {
      throw toRelayableError(error);
    }
  }

  async notification(method: string, params?: unknown): Promise<void> {
    const client = this.client;
    if (!client || this.state !== 'running') {
      throw proxyError('server_down', `local server "${this.name}" is not running`);
    }
    await client.notification({ method, ...(params !== undefined ? { params } : {}) });
  }

  subscribe(listener: UpstreamNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- internals

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

    client.onnotification = (notification) => {
      const { method, params } = notification as { method: string; params?: unknown };
      for (const listener of this.listeners) {
        try {
          listener({ method, ...(params !== undefined ? { params } : {}) });
        } catch {
          /* a listener must never break the relay */
        }
      }
    };

    const onClosed = (): void => {
      if (this.client !== client) return;
      this.client = undefined;
      this.transport = undefined;
      this.handleUnexpectedExit();
    };
    client.onclose = onClosed;

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      this.cachedInfo = undefined;
      this.handleUnexpectedExit((error as Error).message);
      if (this.state === 'failed') {
        throw proxyError('server_down', `local server "${this.name}" failed to start: ${(error as Error).message}`);
      }
      return;
    }

    this.client = client;
    this.transport = transport;
    this.cachedInfo = toUpstreamInfo(client.getInstructions() ? client.getInstructions() : undefined, client);
    this.restartAttempt = 0;
    this.setState('running');
  }

  private handleUnexpectedExit(detail?: string): void {
    if (this.stopping) {
      this.setState('stopped', detail);
      return;
    }
    const maxRestarts = this.options.maxRestarts ?? Number.POSITIVE_INFINITY;
    if (this.restartAttempt >= maxRestarts) {
      this.setState('failed', detail ?? 'child exited');
      return;
    }
    const delays = this.options.restartDelays ?? [250, 500, 1000, 2000, 5000, 10000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)] ?? 0;
    this.restartAttempt += 1;
    this.setState('backoff', detail ?? 'child exited');
    if (this.options.restart === false) {
      this.setState('failed', 'restart disabled');
      return;
    }
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

function toUpstreamInfo(instructions: string | undefined, client: Client): UpstreamInfo {
  const info: InitializeResult = {
    protocolVersion: '2025-06-18',
    capabilities: client.getServerCapabilities() ?? {},
    serverInfo: client.getServerVersion() ?? { name: 'unknown', version: '0.0.0' },
    ...(instructions !== undefined ? { instructions } : {}),
  };
  return {
    protocolVersion: info.protocolVersion,
    capabilities: info.capabilities,
    serverInfo: info.serverInfo,
    ...(info.instructions !== undefined ? { instructions: info.instructions } : {}),
  };
}

export { McpError };

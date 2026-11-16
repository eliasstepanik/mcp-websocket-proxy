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
  ErrorCode,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  McpError,
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
  /**
   * How long a child must stay up before the next restart counts as healthy again
   * (i.e. the backoff schedule and {@link LocalServerOptions.maxRestarts} restart from
   * zero). Default 30000.
   */
  stableUptimeMs?: number | undefined;
  /** Called on every state change. */
  onStateChange?: ((state: LocalServerState, detail?: string) => void) | undefined;
  /** Called with each prefixed stderr line. Defaults to `process.stderr.write`. */
  onStderrLine?: ((line: string) => void) | undefined;
}

const DEFAULT_RESTART_DELAYS = [250, 500, 1000, 2000, 5000, 10000];
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_UPTIME_MS = 30_000;
/** Maximum size of one pending (newline-less) stderr line before it is force-flushed. */
const MAX_STDERR_BUFFER_BYTES = 64 * 1024;

/** Per-spawn stderr state: the pid must come from *this* transport, never from a later one. */
interface StderrSink {
  transport: StdioClientTransport;
  buffer: string;
}

export class LocalMcpServer implements Upstream {
  readonly name: string;

  private readonly options: LocalServerOptions;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  /**
   * The client/transport of a {@link spawn} that has not finished the `initialize`
   * handshake yet. Kept in a field so {@link stop} can close an in-flight child
   * instead of leaking it.
   */
  private pending: { client: Client; transport: StdioClientTransport } | undefined;
  private cachedInfo: UpstreamInfo | undefined;
  private state: LocalServerState = 'stopped';
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly listeners = new Set<UpstreamNotificationListener>();
  /** stderr state of the spawn that is currently running (see {@link StderrSink}). */
  private stderrSink: StderrSink | undefined;
  /** When the current child reached `running`; used to decide whether it was stable. */
  private runningSince = 0;

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
    // Only a server that is not running may be started: starting while `starting`,
    // `running` or `backoff` would spawn a second child next to the live one.
    if (this.state !== 'stopped' && this.state !== 'failed') return;
    this.stopping = false;
    // An explicit start is a fresh slate for the backoff schedule.
    this.restartAttempt = 0;
    await this.spawn();
  }

  /** Stop the child and do not restart it. Safe to call during `start()`. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    // A `start()` may still be awaiting its `initialize` handshake: close that child
    // too, otherwise it is orphaned and would flip the state back to `running`.
    const pending = this.pending;
    this.pending = undefined;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.setState('stopped');
    if (pending) await pending.client.close().catch(() => undefined);
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
      // The SDK hands us the raw `notifications/progress` params (`Record<string, unknown>`).
      // Only forward well-formed progress payloads: `progress` must be a number.
      requestOptions.onprogress = (progress) => {
        if (typeof progress.progress !== 'number') return;
        const { progress: value, total, message, ...rest } = progress;
        options.onProgress?.({
          ...rest,
          progress: value,
          ...(typeof total === 'number' ? { total } : {}),
          ...(typeof message === 'string' ? { message } : {}),
        });
      };
    }

    try {
      return await client.request({ method, ...(params !== undefined ? { params } : {}) } as Request, ResultSchema, requestOptions);
    } catch (error) {
      // Losing the child process mid-request is a proxy-level failure, not an
      // upstream answer: report it as `server_down` so Warren can distinguish it.
      if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed && this.state !== 'running') {
        throw proxyError('server_down', `local server "${this.name}" stopped while the request was in flight`);
      }
      // A deadline we set ourselves is a proxy failure too: the SDK reports it as an
      // upstream `RequestTimeout`, which would look like the child answered with a
      // timeout. Report it as the proxy's own `timeout` reason instead.
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw proxyError('timeout', `local server "${this.name}" did not answer within ${requestOptions.timeout}ms`, {
          timeoutMs: requestOptions.timeout,
        });
      }
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
      // Merge, never replace: a configured `env` must not drop PATH/SYSTEMROOT etc.
      env: { ...getDefaultEnvironment(), ...this.options.env },
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stderr: 'pipe',
    });

    const client = new Client({ name: 'mcp-websocket-proxy-client', version: '0.1.0' });

    // One stderr sink per spawn: the pid in the prefix and the partial-line buffer
    // belong to *this* child, so a dead child's late/partial output can neither be
    // attributed to the next child nor glue onto its first line.
    const previous = this.stderrSink;
    if (previous?.buffer) {
      // The previous child died mid-line: flush its dangling partial line under its
      // own sink now, before this child's output reaches the fresh buffer.
      const dangling = previous.buffer;
      previous.buffer = '';
      this.emitStderrLine(previous, dangling);
    }
    const stderrSink: StderrSink = { transport, buffer: '' };
    this.stderrSink = stderrSink;

    // Remember the in-flight pair so `stop()` can close it (and so a later `stop()`
    // is recognisable here via the identity check after the handshake).
    const pending = { client, transport };
    this.pending = pending;

    transport.stderr?.on('data', (chunk: Buffer) => this.onStderr(stderrSink, chunk));

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
      // A child that stayed up long enough counts as healthy: the next restart may
      // start from the minimum backoff delay again. One that died young keeps the
      // attempt counter climbing, so a crash-looping child reaches `maxRestarts`.
      if (this.runningSince > 0 && Date.now() - this.runningSince >= (this.options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS)) {
        this.restartAttempt = 0;
      }
      this.runningSince = 0;
      this.handleUnexpectedExit();
    };
    client.onerror = () => {
      /* Transport-level noise (unknown progress tokens, unknown message ids) is not fatal here. */
    };

    try {
      await client.connect(transport);
    } catch (error) {
      const abandoned = this.stopping || this.pending !== pending;
      if (this.pending === pending) this.pending = undefined;
      await client.close().catch(() => undefined);
      if (abandoned) {
        // `stop()` already closed this child and reported `stopped`: nothing to restart.
        return;
      }
      // Keep the last good `cachedInfo` (if any): a restart hiccup must not turn new
      // `initialize` requests into 503s. Availability is gated separately by
      // {@link available}, which reads the state, not the cache.
      this.handleUnexpectedExit((error as Error).message);
      throw proxyError('server_down', `local server "${this.name}" failed to start: ${(error as Error).message}`);
    }

    const abandoned = this.stopping || this.pending !== pending;
    this.pending = undefined;
    if (abandoned) {
      // `stop()` ran while the handshake was in flight: never adopt this child, or it
      // would leak and flip the state back to `running`.
      await client.close().catch(() => undefined);
      return;
    }

    this.client = client;
    this.transport = transport;
    this.cachedInfo = {
      protocolVersion: negotiatedProtocolVersion ?? '2025-06-18',
      capabilities: client.getServerCapabilities() ?? {},
      serverInfo: client.getServerVersion() ?? { name: this.name, version: '0.0.0' },
      ...(client.getInstructions() !== undefined ? { instructions: client.getInstructions() } : {}),
    };
    // Uptime, not a successful handshake, decides when the child counts as healthy: a
    // crash-looping child must keep climbing the backoff schedule until `maxRestarts`.
    this.runningSince = Date.now();
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

  private onStderr(sink: StderrSink, chunk: Buffer): void {
    sink.buffer += chunk.toString('utf8');
    const lines = sink.buffer.split('\n');
    sink.buffer = lines.pop() ?? '';
    // A child that never sends a newline must not grow the buffer without bound:
    // force-flush the pending partial line (with a newline of its own) past the cap.
    while (Buffer.byteLength(sink.buffer, 'utf8') > MAX_STDERR_BUFFER_BYTES) {
      const head = sink.buffer.slice(0, MAX_STDERR_BUFFER_BYTES);
      lines.push(head);
      sink.buffer = sink.buffer.slice(head.length);
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      this.emitStderrLine(sink, line);
    }
  }

  private emitStderrLine(sink: StderrSink, line: string): void {
    // The pid comes from this spawn's own transport: `this.transport` may already
    // point at a newer child (startup lines) or at nothing (late lines from a dead
    // child). The line is always prefixed, so a child that writes its own
    // `[name:pid=...]` header cannot masquerade as another server.
    const prefixed = `[${this.name}:pid=${sink.transport.pid ?? '?'}] ${line}`;
    if (this.options.onStderrLine) this.options.onStderrLine(prefixed);
    else process.stderr.write(`${prefixed}\n`);
  }

  private setState(state: LocalServerState, detail?: string): void {
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}

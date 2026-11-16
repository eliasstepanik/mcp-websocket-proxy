/**
 * The server-side WebSocket tunnel handler (T2).
 *
 * One {@link TunnelHandler} == one connected `ws.WebSocket` (the HTTP upgrade and
 * any authentication happen elsewhere; this class only speaks the tunnel
 * protocol). It owns the socket's lifecycle and bookkeeping:
 *
 * - `hello`               -> {@link Registry.registerConnection} + `welcome`
 * - `server_up`           -> {@link Registry.markServerUp} + `server_ack`
 * - `server_down`         -> {@link Registry.markServerDown}
 * - `response`/`progress` -> routed to the in-flight {@link TunnelHandler.sendRequest}
 * - `notification`        -> routed to per-server {@link TunnelHandler.subscribeNotifications}
 * - socket close/error    -> {@link Registry.unregisterConnection} + every in-flight
 *   request rejected with a `client_disconnected` {@link ProxyError}
 *
 * The handler also keeps the connection alive with `ws.ping()`/`pong` heartbeats
 * and enforces the hello and per-request timeouts.
 *
 * Error contract (see `src/shared/errors.ts`): upstream errors reject with
 * {@link UpstreamRpcError} carrying the raw `{code, message, data}` triple so the
 * endpoint can relay it verbatim (no `MCP error <code>:` prefix ever accumulates);
 * proxy-side failures reject with {@link ProxyError} (`code -32050`,
 * `data: {source: "mcp-websocket-proxy", reason}`).
 */

import type { WebSocket } from 'ws';

import {
  parseTunnelMessage,
  PROTOCOL_VERSION,
  SERVER_NAME_RE,
  TunnelProtocolError,
  type Progress,
  type Response,
  type ServerToClient,
  type TunnelMessage,
} from '../shared/protocol.js';
import type { UpstreamInfo, UpstreamNotification, UpstreamProgress } from '../shared/upstream.js';
import { proxyError } from '../shared/errors.js';
import { CLOSE_CODE_REPLACED, Registry, type WsLike } from './registry.js';

/** Close code: a frame was not valid protocol traffic (bad JSON, unknown `type`, ...). */
export const CLOSE_CODE_PROTOCOL = 4000;

/** Close code: no valid `hello` within `helloTimeoutMs`. */
export const CLOSE_CODE_HELLO_TIMEOUT = 4004;

/**
 * A JSON-RPC error that came back from the upstream server, carrying the raw
 * `{code, message, data}` triple. The endpoint detects it through
 * {@link UpstreamRpcError.isUpstreamRpcError} and relays it unchanged.
 */
export class UpstreamRpcError extends Error {
  readonly isUpstreamRpcError = true;
  readonly code: number;
  readonly data: unknown;

  constructor(raw: { code: number; message: string; data?: unknown }) {
    super(raw.message);
    this.name = 'UpstreamRpcError';
    this.code = raw.code;
    this.data = raw.data;
  }
}

export interface TunnelHandlerOptions {
  /** Interval between `ws.ping()` keepalives. Default 15000. */
  heartbeatIntervalMs?: number;
  /** How long to wait for the first `hello` before closing with 4004. Default 5000. */
  helloTimeoutMs?: number;
  /** Default per-request deadline; `sendRequest` may override it per call. Default 300000. */
  requestTimeoutMs?: number;
  /** Reported as `welcome.serverVersion`. */
  serverVersion?: string;
}

export interface SendRequestOptions {
  method: string;
  params?: unknown;
  /** Warren session id, tagged on the frame for attribution only. */
  sessionId?: string;
  /** Ask the client to relay progress frames for this request. */
  wantProgress?: boolean;
  /** Aborting sends `cancel` and rejects with an AbortError (the endpoint treats cancellation as silent). */
  signal?: AbortSignal;
  onProgress?: (progress: UpstreamProgress) => void;
  /** Per-request deadline; defaults to `requestTimeoutMs`. */
  timeoutMs?: number;
}

interface InFlight {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: UpstreamProgress) => void;
  /** Detaches the abort listener. */
  detach?: () => void;
}

type NotificationListener = (notification: UpstreamNotification) => void;

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}

export class TunnelHandler {
  private readonly ws: WebSocket;
  private readonly registry: Registry<WsLike>;
  private readonly heartbeatIntervalMs: number;
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly serverVersion: string | undefined;

  private clientId: string | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private isAlive = true;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<string, InFlight>();
  private readonly subscribers = new Map<string, Set<NotificationListener>>();

  constructor(ws: WebSocket, registry: Registry<WsLike>, opts: TunnelHandlerOptions = {}) {
    this.ws = ws;
    this.registry = registry;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 300_000;
    this.serverVersion = opts.serverVersion;

    this.helloTimer = setTimeout(() => this.close(CLOSE_CODE_HELLO_TIMEOUT, 'hello timeout'), this.helloTimeoutMs);
    this.helloTimer.unref?.();

    this.ws.on('message', (data: unknown) => this.onMessage(data));
    this.ws.on('pong', () => {
      this.isAlive = true;
    });
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', () => this.cleanup());
  }

  /** The `clientId` from the accepted `hello`; `undefined` until then. */
  get clientIdValue(): string | undefined {
    return this.clientId;
  }

  /**
   * Relay a JSON-RPC request to a server on this connection and await its raw
   * `result`. Rejects with {@link UpstreamRpcError} when the upstream answered an
   * error, with a `timeout` {@link ProxyError} on deadline (after sending `cancel`)
   * and with an AbortError when `signal` aborts (after sending `cancel`).
   */
  sendRequest(server: string, options: SendRequestOptions): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(proxyError('client_disconnected', `tunnel for ${JSON.stringify(server)} is closed`));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const key = String(id);

    return new Promise<unknown>((resolve, reject) => {
      const inflight: InFlight = { resolve, reject, onProgress: options.onProgress };
      this.pending.set(key, inflight);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void): void => {
        if (!this.pending.has(key)) return;
        if (timer) clearTimeout(timer);
        inflight.detach?.();
        this.pending.delete(key);
        fn();
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.send({ type: 'cancel', id, reason: 'timeout' });
          settle(() => reject(proxyError('timeout', `request to ${JSON.stringify(server)} timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        timer.unref?.();
      }

      const signal = options.signal;
      if (signal) {
        const onAbort = (): void => {
          this.send({ type: 'cancel', id, reason: 'client_cancelled' });
          settle(() => reject(new Error('This operation was aborted')));
        };
        if (signal.aborted) {
          settle(() => reject(new Error('This operation was aborted')));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        inflight.detach = () => signal.removeEventListener('abort', onAbort);
      }

      this.send({
        type: 'request',
        id,
        server,
        ...(options.sessionId !== undefined ? { session: options.sessionId } : {}),
        method: options.method,
        ...(options.params !== undefined ? { params: options.params } : {}),
        ...(options.wantProgress ? { wantProgress: true } : {}),
      });
    });
  }

  /** Subscribe to upstream-originated notifications for `server`. Returns an unsubscribe function. */
  subscribeNotifications(server: string, cb: NotificationListener): () => void {
    let set = this.subscribers.get(server);
    if (!set) {
      set = new Set();
      this.subscribers.set(server, set);
    }
    set.add(cb);
    return () => {
      const current = this.subscribers.get(server);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.subscribers.delete(server);
    };
  }

  /** Close the tunnel and fail everything in flight. */
  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone */
    }
    this.cleanup();
  }

  // -------------------------------------------------------------------------

  private onMessage(data: unknown): void {
    let msg: TunnelMessage;
    try {
      msg = parseTunnelMessage(toText(data), 'in');
    } catch (error) {
      // A `server_up` whose only problem is a malformed name is answered politely
      // (the client learns *which* name was bad); everything else is a protocol close.
      if (this.clientId && this.ackInvalidServerName(data)) return;
      const detail = error instanceof TunnelProtocolError ? error.message : String(error);
      this.close(CLOSE_CODE_PROTOCOL, `protocol error: ${detail}`);
      return;
    }

    if (!this.clientId) {
      if (msg.type !== 'hello') {
        this.close(CLOSE_CODE_PROTOCOL, 'expected hello');
        return;
      }
      this.onHello(msg.clientId);
      return;
    }

    switch (msg.type) {
      case 'hello':
        this.close(CLOSE_CODE_PROTOCOL, 'duplicate hello');
        return;
      case 'server_up': {
        // The wire schema already validates the name, so `invalid_name` cannot come
        // out of the registry here; bad names are handled in {@link ackInvalidServerName}.
        let ack: { ok: true } | { ok: false; error: 'name_conflict' | 'invalid_name' } = { ok: false, error: 'name_conflict' };
        try {
          ack = this.registry.markServerUp(this.clientId, msg.server, msg.info as unknown as UpstreamInfo);
        } catch {
          /* unknown client: ack stays not-ok */
        }
        this.send({ type: 'server_ack', server: msg.server, ...ack });
        return;
      }
      case 'server_down':
        this.registry.markServerDown(this.clientId, msg.server, msg.reason);
        return;
      case 'response':
        this.onResponse(msg);
        return;
      case 'progress':
        this.onProgress(msg);
        return;
      case 'notification': {
        const listeners = this.subscribers.get(msg.server);
        if (!listeners) return;
        for (const cb of [...listeners]) {
          try {
            cb({ method: msg.method, params: msg.params });
          } catch {
            /* a subscriber must never break the tunnel */
          }
        }
        return;
      }
      default: {
        // `welcome`/`request`/`cancel`/`server_ack` are server->client frames: a
        // client sending them is speaking the wrong direction.
        const unknown: string = (msg as { type?: string }).type ?? 'unknown';
        this.close(CLOSE_CODE_PROTOCOL, `unknown message type: ${unknown}`);
      }
    }
  }

  /**
   * Answer a `server_up` whose server name fails {@link SERVER_NAME_RE} with
   * `server_ack {ok:false, error:"invalid_name"}` instead of a protocol close.
   * Returns false when `data` is not such a frame.
   */
  private ackInvalidServerName(data: unknown): boolean {
    let decoded: unknown;
    try {
      decoded = JSON.parse(toText(data));
    } catch {
      return false;
    }
    if (typeof decoded !== 'object' || decoded === null) return false;
    const record = decoded as Record<string, unknown>;
    if (record.type !== 'server_up' || typeof record.server !== 'string') return false;
    if (SERVER_NAME_RE.test(record.server)) return false;
    // Bypass the typed send: an invalid name cannot pass the wire schema.
    this.sendRaw(JSON.stringify({ type: 'server_ack', server: record.server, ok: false, error: 'invalid_name' }));
    return true;
  }

  private onHello(clientId: string): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
    this.clientId = clientId;
    const { replaced } = this.registry.registerConnection(clientId, this.ws);
    if (replaced && replaced.ws !== this.ws) {
      try {
        replaced.ws.close(CLOSE_CODE_REPLACED, 'replaced by a newer connection');
      } catch {
        /* already gone */
      }
    }
    this.send({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      ...(this.serverVersion !== undefined ? { serverVersion: this.serverVersion } : {}),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
    this.startHeartbeat();
  }

  private onResponse(msg: Response): void {
    const inflight = this.pending.get(String(msg.id));
    if (!inflight) return;
    inflight.detach?.();
    this.pending.delete(String(msg.id));
    if (msg.error) {
      inflight.reject(new UpstreamRpcError({ code: msg.error.code, message: msg.error.message, data: msg.error.data }));
    } else {
      inflight.resolve(msg.result);
    }
  }

  private onProgress(msg: Progress): void {
    const inflight = this.pending.get(String(msg.id));
    if (!inflight?.onProgress) return;
    try {
      inflight.onProgress({ ...msg.params });
    } catch {
      /* a progress callback must never break the tunnel */
    }
  }

  private startHeartbeat(): void {
    this.isAlive = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        try {
          this.ws.terminate();
        } catch {
          /* already gone */
        }
        this.cleanup();
        return;
      }
      this.isAlive = false;
      try {
        this.ws.ping();
      } catch {
        /* already gone */
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // Only unregister when this connection is still the registry's: a replaced one
    // must not tear down the connection that took its place.
    if (this.clientId && this.registry.get(this.clientId)?.ws === this.ws) {
      this.registry.unregisterConnection(this.clientId);
    }
    for (const inflight of this.pending.values()) {
      inflight.detach?.();
      inflight.reject(proxyError('client_disconnected', 'the tunnel connection dropped while the request was in flight'));
    }
    this.pending.clear();
    this.subscribers.clear();
  }

  private send(message: ServerToClient): void {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(text: string): void {
    if (this.ws.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      this.ws.send(text);
    } catch {
      /* socket died mid-write; the close/error handler cleans up */
    }
  }
}

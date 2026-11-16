/**
 * The client half of the WebSocket tunnel (T2, runs on the Windows work PC).
 *
 * A {@link TunnelClient} dials **out** to the proxy server and keeps the
 * connection alive forever:
 *
 * - open   -> `hello {protocol, clientId, clientVersion}` (with an
 *             `Authorization: Bearer <token>` header on the upgrade request)
 * - welcome -> `server_up` for every available {@link LocalMcpServer}
 * - local server becomes available  -> `server_up` (info = captured `initialize` result)
 * - local server goes down          -> `server_down {server, reason}`
 * - `request` -> dispatched to the named {@link LocalMcpServer}; answered with
 *                `response {result}` or `response {error}` carrying the raw
 *                `{code, message, data}` triple when the failure has one
 *                (upstream RPC / proxy errors), `-32603` otherwise; an unknown
 *                server answers `-32601`
 * - `cancel` -> aborts the matching in-flight request (AbortController)
 * - socket close -> reconnect with 1s doubling backoff capped at
 *                   `maxReconnectDelayMs`, ±20% jitter, forever; close codes
 *                   4002/4003 wait 60s instead. After every `welcome` the
 *                   `server_up` frames are re-sent (repeated when the info
 *                   changed). Local children keep running while disconnected.
 */

import WebSocket from 'ws';

import {
  parseTunnelMessage,
  PROTOCOL_VERSION,
  type ClientToServer,
  type Request,
  type ServerToClient,
} from '../shared/protocol.js';
import type { UpstreamInfo } from '../shared/upstream.js';
import type { LocalMcpServer } from './local-server.js';

/** Close code: this connection was replaced by a newer one with the same clientId. */
const CLOSE_CODE_REPLACED = 4002;

/** Close code: the server rejected the credentials (auth failure). */
const CLOSE_CODE_UNAUTHORIZED = 4003;

/** How long to wait after a 4002/4003 close before dialing again. */
const AUTH_OR_REPLACE_RETRY_MS = 60_000;

/** First reconnect delay; doubles from here up to `maxReconnectDelayMs`. */
const BASE_RECONNECT_DELAY_MS = 1_000;

/** Relative jitter applied to every reconnect delay (±20%). */
const RECONNECT_JITTER = 0.2;

/** JSON-RPC "method not found": used for a request naming an unknown server. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/** JSON-RPC "internal error": the fallback when a failure carries no raw triple. */
const JSONRPC_INTERNAL_ERROR = -32603;

export type TunnelClientState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface TunnelClientOptions {
  /** The server's tunnel endpoint, e.g. `wss://warren.example.com/tunnel`. */
  url: string;
  /** Relay token, sent as `Authorization: Bearer <token>` on the upgrade. */
  token: string;
  /** Stable identity of this machine; a reconnect with the same id takes over. */
  clientId: string;
  /** Reported in `hello.clientVersion`. */
  clientVersion?: string | undefined;
  /** The local servers to expose, keyed by tunnel server name. */
  servers: Map<string, LocalMcpServer>;
  /** Upper bound for the exponential reconnect backoff. Default 30000. */
  maxReconnectDelayMs?: number | undefined;
}

/** One request the local server is currently running for the tunnel. */
interface InFlight {
  controller: AbortController;
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}

/**
 * Turn whatever a local server threw into the wire error object.
 *
 * Upstream RPC errors and proxy errors both carry a raw `{code, message, data}`
 * triple (`McpError`/`UpstreamRpcError`); those are relayed unchanged so Warren
 * sees the upstream code. Anything else becomes an internal error.
 */
function toWireError(error: unknown): { code: number; message: string; data?: unknown } {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      const data = (error as { data?: unknown }).data;
      return { code, message, ...(data !== undefined ? { data } : {}) };
    }
  }
  return { code: JSONRPC_INTERNAL_ERROR, message };
}

/** Serialised `initialize` info, used to skip a `server_up` that changes nothing. */
function infoKey(info: UpstreamInfo): string {
  return JSON.stringify(info);
}

export class TunnelClient {
  private readonly url: string;
  private readonly token: string;
  private readonly clientId: string;
  private readonly clientVersion: string | undefined;
  private readonly servers: Map<string, LocalMcpServer>;
  private readonly maxReconnectDelayMs: number;

  private ws: WebSocket | undefined;
  private current: TunnelClientState = 'connecting';
  private stopped = false;
  /** Number of consecutive failed reconnect attempts; drives the backoff. */
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Requests the local servers are running right now, keyed by wire id. */
  private readonly inFlight = new Map<string, InFlight>();
  /** The `info` last sent in a `server_up`, per server name. */
  private readonly advertised = new Map<string, string>();
  /** Detaches the per-server state listeners. */
  private readonly unsubs = new Map<string, () => void>();

  constructor(options: TunnelClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.clientId = options.clientId;
    this.clientVersion = options.clientVersion;
    this.servers = options.servers;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;

    for (const [name, server] of this.servers) {
      this.unsubs.set(name, server.subscribeState((state, detail) => this.onServerState(name, state, detail)));
    }

    this.dial();
  }

  /** The current connection state. */
  get state(): TunnelClientState {
    return this.current;
  }

  /** Stop reconnecting and close the socket with 1001. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const unsub of this.unsubs.values()) unsub();
    this.unsubs.clear();
    this.inFlight.clear();
    this.advertised.clear();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1001, 'client shutdown');
    } catch {
      /* already gone */
    }
    this.setState('stopped');
  }

  // ------------------------------------------------------------------ dialing

  private dial(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState('connected');
      this.send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        clientId: this.clientId,
        ...(this.clientVersion !== undefined ? { clientVersion: this.clientVersion } : {}),
      });
    });
    ws.on('message', (data: unknown) => {
      if (this.ws !== ws) return;
      this.onMessage(data);
    });
    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      // Children keep running while disconnected: in-flight requests are *not*
      // aborted here; their answers simply have nowhere to go until the next
      // `welcome` re-registers the servers.
      this.scheduleReconnect(code);
    });
    ws.on('error', () => {
      /* `close` always follows an error and drives the reconnect */
    });
  }

  /** Backoff: 1s doubling to `maxReconnectDelayMs`, ±20% jitter; 60s after 4002/4003. */
  private scheduleReconnect(closeCode: number): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    let delay: number;
    if (closeCode === CLOSE_CODE_REPLACED || closeCode === CLOSE_CODE_UNAUTHORIZED) {
      delay = AUTH_OR_REPLACE_RETRY_MS;
      this.attempt = 0;
    } else {
      const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** this.attempt, this.maxReconnectDelayMs);
      this.attempt += 1;
      delay = base * (1 + RECONNECT_JITTER * (Math.random() * 2 - 1));
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.setState('connecting');
      this.dial();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setState(state: TunnelClientState): void {
    this.current = state;
  }

  // ------------------------------------------------------------------ framing

  private onMessage(data: unknown): void {
    let msg: ServerToClient;
    try {
      msg = parseTunnelMessage(toText(data), 'out') as ServerToClient;
    } catch {
      // Nothing useful can be answered on a frame we cannot parse; the server side
      // is authoritative, so ignore the noise and let its own guards act.
      return;
    }

    switch (msg.type) {
      case 'welcome':
        this.attempt = 0;
        // The server forgot everything it knew about this connection: every
        // available server must be advertised again, even an unchanged one.
        this.advertised.clear();
        this.advertiseAll();
        return;
      case 'request':
        void this.onRequest(msg);
        return;
      case 'cancel':
        this.inFlight.get(String(msg.id))?.controller.abort(msg.reason ?? 'cancelled by the server');
        return;
      case 'server_ack':
        // The server is authoritative about ownership; a rejected `server_up` is
        // simply not retried until the next `welcome` or state change.
        return;
      default:
        return;
    }
  }

  /** `server_up` for every available local server whose info is new or changed. */
  private advertiseAll(): void {
    for (const [name, server] of this.servers) {
      if (!server.available) {
        this.advertised.delete(name);
        continue;
      }
      this.advertise(name, server);
    }
  }

  private advertise(name: string, server: LocalMcpServer): void {
    let info: UpstreamInfo;
    try {
      info = server.info;
    } catch {
      // No cached `initialize` result yet: nothing to advertise.
      return;
    }
    const key = infoKey(info);
    if (this.advertised.get(name) === key) return;
    this.advertised.set(name, key);
    this.send({ type: 'server_up', server: name, info });
  }

  /** Reacts to a local child's state change while the tunnel is live. */
  private onServerState(name: string, state: string, detail?: string): void {
    const server = this.servers.get(name);
    if (!server) return;
    if (server.available) {
      this.advertise(name, server);
      return;
    }
    if (this.advertised.delete(name)) {
      this.send({ type: 'server_down', server: name, reason: detail ?? `local server ${state}` });
    }
  }

  private send(message: ClientToServer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket died mid-write; the close handler drives the reconnect */
    }
  }

  /** Dispatch one inbound request to its local server and answer with a `response`. */
  private async onRequest(msg: Request): Promise<void> {
    const key = String(msg.id);
    const server = this.servers.get(msg.server);
    if (!server) {
      this.send({
        type: 'response',
        id: msg.id,
        error: { code: JSONRPC_METHOD_NOT_FOUND, message: `unknown server ${JSON.stringify(msg.server)}` },
      });
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(key, { controller });

    try {
      const result = await server.request(msg.method, msg.params, {
        signal: controller.signal,
        ...(msg.wantProgress
          ? {
              onProgress: (progress: { progress: number; total?: number; message?: string }) => {
                this.send({ type: 'progress', id: msg.id, params: { ...progress } });
              },
            }
          : {}),
      });
      this.send({ type: 'response', id: msg.id, result });
    } catch (error) {
      this.send({ type: 'response', id: msg.id, error: toWireError(error) });
    } finally {
      this.inFlight.delete(key);
    }
  }
}

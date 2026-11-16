/**
 * The `Upstream` implementation for one tunnel-registered server name (T2).
 *
 * A {@link TunnelUpstream} is *not* a connection: it is a stable handle for one
 * server name that resolves the current tunnel on **every** call. The tunnel
 * behind a name changes whenever the client reconnects (a new {@link TunnelHandler}
 * takes over the same `clientId`), so caching a tunnel here would pin a dead
 * socket; caching nothing would break the endpoint, which holds one upstream per
 * Warren session. The name-keyed handle is the seam that survives reconnects.
 *
 * Error contract (see `src/shared/errors.ts` and `src/server/mcp-endpoint.ts`):
 * - no registry entry at all -> {@link ProxyError} reason `offline`
 * - entry present but down   -> {@link ProxyError} reason `server_down`
 * Both are retryable reasons: the endpoint's `proxyReasonOf()` maps them to a
 * `503` + `retry-after` answer to `initialize`, so the reason must be carried on
 * the error exactly (which {@link proxyError} does).
 * - an {@link UpstreamRpcError} coming back from the client is rethrown **as the
 *   same object**: the raw `{code, message, data}` triple must reach Warren
 *   without an added `MCP error <code>:` prefix.
 *
 * {@link TunnelUpstreams} hands out one stable instance per name and owns the
 * tunnel subscriptions, re-binding them when a connection is replaced.
 */

import { proxyError } from '../shared/errors.js';
import type { LookupResult } from './registry.js';
import type {
  Upstream,
  UpstreamInfo,
  UpstreamNotification,
  UpstreamNotificationListener,
  UpstreamProgress,
  UpstreamRequestOptions,
} from '../shared/upstream.js';

/**
 * The tunnel operations a {@link TunnelUpstream} needs.
 *
 * {@link TunnelHandler} satisfies `sendRequest`/`subscribeNotifications` directly;
 * `sendNotification` is the one frame type the handler does not expose yet, so the
 * wiring layer (T2d) supplies it as a thin adapter over the socket. Keeping it in
 * this interface is what lets the upstream be unit-tested with a plain object.
 */
export interface TunnelUpstreamTransport {
  sendRequest(
    server: string,
    options: {
      method: string;
      params?: unknown;
      sessionId?: string;
      wantProgress?: boolean;
      signal?: AbortSignal;
      onProgress?: (progress: UpstreamProgress) => void;
      timeoutMs?: number;
    },
  ): Promise<unknown>;
  /** Relay a `notification` frame to the client for `server`. */
  sendNotification(server: string, method: string, params?: unknown): void;
  subscribeNotifications(server: string, cb: UpstreamNotificationListener): () => void;
}

/**
 * True when `error` is an upstream JSON-RPC error relayed by the tunnel.
 *
 * Duck-typed (like `isProxyError`) rather than `instanceof`, so an error that
 * crossed a module boundary still passes through unchanged.
 */
export function isUpstreamRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { isUpstreamRpcError?: unknown; code?: unknown };
  return candidate.isUpstreamRpcError === true && typeof candidate.code === 'number';
}

/** Resolves the tunnel that currently serves `name`, if any. */
export type TunnelResolver = (name: string) => TunnelUpstreamTransport | undefined;

/** The part of {@link Registry} a {@link TunnelUpstream} reads; a plain object satisfies it. */
export interface UpstreamRegistry {
  lookup(name: string): LookupResult | undefined;
}

/**
 * One proxied server name, backed by live Registry + tunnel lookups.
 *
 * Never caches a tunnel: {@link Registry.lookup} runs per call, so a reconnect
 * (new `TunnelHandler`, same `clientId`, same name) is picked up by the next
 * request without the endpoint noticing.
 */
export class TunnelUpstream implements Upstream {
  readonly name: string;

  private readonly registry: UpstreamRegistry;
  private readonly resolveTunnel: TunnelResolver;
  private readonly listeners = new Set<UpstreamNotificationListener>();
  /** Detaches the current tunnel subscription, when one is bound. */
  private detachTunnel: (() => void) | undefined;

  constructor(name: string, registry: UpstreamRegistry, resolveTunnel: TunnelResolver) {
    this.name = name;
    this.registry = registry;
    this.resolveTunnel = resolveTunnel;
  }

  /**
   * The cached `initialize` result as registered by the client.
   *
   * @throws {ProxyError} `offline` when no connection has claimed the name,
   *         `server_down` when the name is claimed but its local server is not
   *         running. The endpoint turns both into `503` + `retry-after`.
   */
  get info(): UpstreamInfo {
    const entry = this.registry.lookup(this.name);
    if (!entry) throw proxyError('offline', `no tunnel is serving server ${JSON.stringify(this.name)}`);
    if (!entry.up) throw proxyError('server_down', `server ${JSON.stringify(this.name)} is registered but down`);
    return entry.info;
  }

  /** True when the name is registered and its local server is up. */
  get available(): boolean {
    const entry = this.registry.lookup(this.name);
    return entry !== undefined && entry.up;
  }

  /**
   * Relay a JSON-RPC request over the current tunnel.
   *
   * Rejects with `offline`/`server_down` when nothing can serve it, with the
   * tunnel's own `client_disconnected`/`timeout` {@link ProxyError} when the
   * connection drops or the deadline passes, and with the upstream's
   * {@link UpstreamRpcError} unchanged.
   */
  request(method: string, params?: unknown, options?: UpstreamRequestOptions): Promise<unknown> {
    const tunnel = this.liveTunnel();
    return tunnel.sendRequest(this.name, {
      method,
      ...(params !== undefined ? { params } : {}),
      ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      // The client only emits `progress` frames when the request asks for them.
      ...(options?.onProgress !== undefined ? { wantProgress: true, onProgress: options.onProgress } : {}),
    });
  }

  /**
   * Relay a JSON-RPC notification (Warren -> upstream, e.g.
   * `notifications/cancelled`).
   *
   * @throws {ProxyError} `offline`/`server_down` when no live tunnel owns the name.
   */
  notification(method: string, params?: unknown): Promise<void> {
    const tunnel = this.liveTunnel();
    tunnel.sendNotification(this.name, method, params);
    return Promise.resolve();
  }

  /**
   * Subscribe to notifications the upstream emits for this name. The subscription
   * is re-bound to the current tunnel, so it keeps working after a reconnect.
   * Returns an unsubscribe function.
   */
  subscribe(listener: UpstreamNotificationListener): () => void {
    this.listeners.add(listener);
    this.bind();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.unbind();
    };
  }

  /**
   * Re-attach to the current tunnel (called by {@link TunnelUpstreams} when a
   * connection is replaced). No-op while nothing is subscribed.
   */
  rebind(): void {
    if (this.listeners.size === 0) return;
    this.unbind();
    this.bind();
  }

  /** Deliver one upstream notification to every local subscriber. */
  dispatch(notification: UpstreamNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch {
        /* a subscriber must never break the tunnel */
      }
    }
  }

  // -------------------------------------------------------------------------

  /** The tunnel that can serve this name now, or a thrown proxy error. */
  private liveTunnel(): TunnelUpstreamTransport {
    const entry = this.registry.lookup(this.name);
    if (!entry) throw proxyError('offline', `no tunnel is serving server ${JSON.stringify(this.name)}`);
    if (!entry.up) throw proxyError('server_down', `server ${JSON.stringify(this.name)} is registered but down`);
    const tunnel = this.resolveTunnel(this.name);
    if (!tunnel) throw proxyError('offline', `no live tunnel for server ${JSON.stringify(this.name)}`);
    return tunnel;
  }

  private bind(): void {
    if (this.detachTunnel) return;
    const tunnel = this.resolveTunnel(this.name);
    if (!tunnel) return;
    this.detachTunnel = tunnel.subscribeNotifications(this.name, (notification) => this.dispatch(notification));
  }

  private unbind(): void {
    this.detachTunnel?.();
    this.detachTunnel = undefined;
  }
}

/**
 * One {@link TunnelUpstream} per server name (Map cache keyed by name) plus the
 * tunnel bookkeeping needed to keep subscriptions alive across reconnects.
 *
 * Wiring in `app.ts` (T2d):
 * ```ts
 * const upstreams = new TunnelUpstreams(registry);
 * // on `hello`:      upstreams.track(clientId, tunnel)
 * // on `server_up`:  createMcpEndpointHandler({ name, upstream: () => upstreams.get(name) })
 * // on close:        upstreams.untrack(clientId)
 * ```
 */
export class TunnelUpstreams {
  private readonly registry: UpstreamRegistry;
  private readonly tunnels: Map<string, TunnelUpstreamTransport>;
  private readonly upstreams = new Map<string, TunnelUpstream>();

  constructor(registry: UpstreamRegistry, tunnelsByConnection: Map<string, TunnelUpstreamTransport> = new Map()) {
    this.registry = registry;
    this.tunnels = tunnelsByConnection;
  }

  /** The stable upstream handle for `name`, created on first call. */
  get(name: string): TunnelUpstream {
    let upstream = this.upstreams.get(name);
    if (!upstream) {
      upstream = new TunnelUpstream(name, this.registry, (lookupName) => {
        const entry = this.registry.lookup(lookupName);
        return entry ? this.tunnels.get(entry.connection.clientId) : undefined;
      });
      this.upstreams.set(name, upstream);
    }
    return upstream;
  }

  /** Every upstream handed out so far, sorted by name. */
  list(): TunnelUpstream[] {
    return [...this.upstreams.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Stop handing out a handle for `name` (existing sessions keep working). */
  drop(name: string): void {
    this.upstreams.delete(name);
  }

  /** Register the tunnel for `clientId` and re-bind the names it now owns. */
  track(connectionId: string, tunnel: TunnelUpstreamTransport): void {
    this.tunnels.set(connectionId, tunnel);
    for (const upstream of this.upstreams.values()) upstream.rebind();
  }

  /** Forget the tunnel for `clientId` (socket close); its names go `offline`. */
  untrack(connectionId: string): void {
    this.tunnels.delete(connectionId);
    for (const upstream of this.upstreams.values()) upstream.rebind();
  }
}

/**
 * `app.ts` (T2d) seam:
 * ```ts
 * const upstreamFor = createTunnelUpstreamFactory(registry, tunnelsByConnection);
 * // on `server_up`: createMcpEndpointHandler({ name, upstream: () => upstreamFor(name) })
 * ```
 */
export function createTunnelUpstreamFactory(
  registry: UpstreamRegistry,
  tunnelsByConnection: Map<string, TunnelUpstreamTransport> = new Map(),
): (name: string) => TunnelUpstream {
  const manager = new TunnelUpstreams(registry, tunnelsByConnection);
  return (name: string) => manager.get(name);
}

/**
 * In-memory registry of connected tunnel clients and the MCP server names they
 * have registered (T2, server side).
 *
 * Pure bookkeeping: no sockets are read or written, no timers. The transport
 * layer (the `ws` handler) owns the socket and calls into the registry:
 *
 * - `hello`            -> {@link Registry.registerConnection}
 * - `server_up`        -> {@link Registry.markServerUp}
 * - `server_down`      -> {@link Registry.markServerDown}
 * - socket close/error -> {@link Registry.unregisterConnection}
 *
 * Ownership of a server name belongs to the **first** registrant and is kept
 * until that connection goes away (then the name is released and may be claimed
 * again). The registry never closes a socket itself: when a `clientId` reconnects
 * the replaced connection is reported so the caller can close it with
 * {@link CLOSE_CODE_REPLACED}.
 *
 * The WebSocket type is kept out of this module: a connection holds a minimal
 * {@link WsLike} handle (structurally satisfied by `ws.WebSocket`), so the
 * registry is unit-testable with a plain object.
 */

import { SERVER_NAME_RE } from '../shared/protocol.js';
import type { UpstreamInfo } from '../shared/upstream.js';

/** Close code sent to a connection that was replaced by a newer one with the same `clientId`. */
export const CLOSE_CODE_REPLACED = 4002;

/** Default `server_down` reason used when a connection disappears. */
export const REASON_CONNECTION_LOST = 'connection_lost';

/** The minimum a handle must offer; `ws.WebSocket` satisfies it structurally. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** One connected tunnel client and the server names it owns. */
export interface ClientConnection<T extends WsLike = WsLike> {
  readonly clientId: string;
  readonly ws: T;
  /** Names currently owned by this connection (up *and* down). */
  readonly servers: Set<string>;
}

/** One registered server name and its current state. */
export interface ServerEntry<T extends WsLike = WsLike> {
  readonly name: string;
  readonly clientId: string;
  info: UpstreamInfo;
  up: boolean;
  connection: ClientConnection<T>;
}

/** Result of {@link Registry.lookup}. */
export interface LookupResult<T extends WsLike = WsLike> {
  readonly connection: ClientConnection<T>;
  readonly info: UpstreamInfo;
  readonly up: boolean;
}

/** Row of {@link Registry.listServers} (for a future `/status`). */
export interface ServerStatus<T extends WsLike = WsLike> extends LookupResult<T> {
  readonly name: string;
  readonly clientId: string;
}

export type MarkServerUpResult = { ok: true } | { ok: false; error: 'name_conflict' | 'invalid_name' };

export interface RegisterResult<T extends WsLike = WsLike> {
  readonly connection: ClientConnection<T>;
  /** The previous connection with the same `clientId`, if any. Close it with {@link CLOSE_CODE_REPLACED}. */
  readonly replaced: ClientConnection<T> | undefined;
}

export interface ServerUpEvent {
  readonly type: 'server_up';
  readonly clientId: string;
  readonly server: string;
  readonly info: UpstreamInfo;
}

export interface ServerDownEvent {
  readonly type: 'server_down';
  readonly clientId: string;
  readonly server: string;
  readonly reason: string;
}

export interface ConnectionLostEvent {
  readonly type: 'connection_lost';
  readonly clientId: string;
  /** The names that were released, in registration order. */
  readonly servers: string[];
}

export type RegistryEvent = ServerUpEvent | ServerDownEvent | ConnectionLostEvent;

export type RegistryListener = (event: RegistryEvent) => void;

/** Raised on a registry misuse (a frame for a `clientId` that never said `hello`). */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class Registry<T extends WsLike = WsLike> {
  private readonly clients = new Map<string, ClientConnection<T>>();
  private readonly servers = new Map<string, ServerEntry<T>>();
  private readonly listeners = new Set<RegistryListener>();

  /**
   * Record a live connection. A previous connection with the same `clientId` is
   * replaced: the new connection inherits its server names (ownership is per
   * `clientId`, so a reconnect may re-`server_up` the same names) and the old one
   * is reported so the caller can close it with {@link CLOSE_CODE_REPLACED}.
   *
   * Inherited names are marked **down** and a `server_down` is emitted for each:
   * the new socket has advertised nothing yet, so nothing may be routed over it
   * until the client re-`server_up`s the name after `welcome`. Ownership is kept,
   * so the re-advertisement is a refresh rather than a conflict.
   */
  registerConnection(clientId: string, ws: T): RegisterResult<T> {
    const previous = this.clients.get(clientId);
    const connection: ClientConnection<T> = {
      clientId,
      ws,
      servers: new Set(previous ? previous.servers : []),
    };
    this.clients.set(clientId, connection);
    for (const name of connection.servers) {
      const entry = this.servers.get(name);
      if (!entry || entry.clientId !== clientId) continue;
      entry.connection = connection;
      if (entry.up) {
        entry.up = false;
        this.emit({ type: 'server_down', clientId, server: name, reason: REASON_CONNECTION_REPLACED });
      }
    }
    return { connection, replaced: previous };
  }

  /**
   * Forget a connection. Every server it owned is marked down with `reason`
   * (emitting `server_down` for each) and released, then a `connection_lost`
   * event is emitted. Returns the removed connection, or `undefined` when the
   * `clientId` was unknown.
   */
  unregisterConnection(clientId: string, reason: string = REASON_CONNECTION_LOST): ClientConnection<T> | undefined {
    const connection = this.clients.get(clientId);
    if (!connection) return undefined;
    this.clients.delete(clientId);

    const released: string[] = [];
    for (const name of [...connection.servers]) {
      connection.servers.delete(name);
      const entry = this.servers.get(name);
      if (!entry || entry.clientId !== clientId) continue;
      this.servers.delete(name);
      if (entry.up) this.emit({ type: 'server_down', clientId, server: name, reason });
      released.push(name);
    }
    this.emit({ type: 'connection_lost', clientId, servers: released });
    return connection;
  }

  /**
   * Register (or refresh) a server name for `clientId`.
   *
   * @throws {RegistryError} when `clientId` has no live connection.
   */
  markServerUp(clientId: string, name: string, info: UpstreamInfo): MarkServerUpResult {
    const connection = this.clients.get(clientId);
    if (!connection) {
      throw new RegistryError(`cannot register server ${JSON.stringify(name)}: unknown client ${JSON.stringify(clientId)}`);
    }
    if (!SERVER_NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };

    const existing = this.servers.get(name);
    if (existing && existing.clientId !== clientId) return { ok: false, error: 'name_conflict' };

    this.servers.set(name, { name, clientId, info, up: true, connection });
    connection.servers.add(name);
    this.emit({ type: 'server_up', clientId, server: name, info });
    return { ok: true };
  }

  /**
   * Mark a server down; the owning connection keeps the name (it may come back).
   * Returns false when the name is unknown, owned by someone else or already down
   * (no event is emitted in that case).
   */
  markServerDown(clientId: string, name: string, reason: string): boolean {
    const entry = this.servers.get(name);
    if (!entry || entry.clientId !== clientId || !entry.up) return false;
    entry.up = false;
    this.emit({ type: 'server_down', clientId, server: name, reason });
    return true;
  }

  /** The connection that owns `name`, its cached info and whether it is up. */
  lookup(name: string): LookupResult<T> | undefined {
    const entry = this.servers.get(name);
    if (!entry) return undefined;
    return { connection: entry.connection, info: entry.info, up: entry.up };
  }

  /** Every registered server, sorted by name. */
  listServers(): ServerStatus<T>[] {
    return [...this.servers.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({
        name: entry.name,
        clientId: entry.clientId,
        connection: entry.connection,
        info: entry.info,
        up: entry.up,
      }));
  }

  get(clientId: string): ClientConnection<T> | undefined {
    return this.clients.get(clientId);
  }

  connections(): ClientConnection<T>[] {
    return [...this.clients.values()];
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  get serverCount(): number {
    return this.servers.size;
  }

  /** Subscribe to registry events. Returns an unsubscribe function. */
  on(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

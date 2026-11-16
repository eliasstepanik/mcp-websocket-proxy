import { describe, expect, it, vi } from 'vitest';

import {
  TunnelUpstream,
  TunnelUpstreams,
  createTunnelUpstreamFactory,
  isUpstreamRpcError,
  type TunnelUpstreamTransport,
  type UpstreamRegistry,
} from '../../src/server/tunnel-upstream.js';
import { UpstreamRpcError } from '../../src/server/tunnel.js';
import { PROXY_ERROR_CODE, PROXY_ERROR_SOURCE, isProxyError } from '../../src/shared/errors.js';
import type { LookupResult } from '../../src/server/registry.js';
import type { UpstreamInfo } from '../../src/shared/upstream.js';

const info = (name: string): UpstreamInfo => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name, version: '1.0.0' },
});

/** A fake registry: a plain name -> lookup map, no sockets. */
function fakeRegistry(entries: Map<string, LookupResult>): UpstreamRegistry & { entries: Map<string, LookupResult> } {
  return {
    entries,
    lookup: (name: string) => entries.get(name),
  };
}

/** A fake tunnel: records what it was asked to do, answers from a queue. */
function fakeTunnel(): TunnelUpstreamTransport & {
  requests: Array<{ server: string; options: unknown }>;
  notifications: Array<{ server: string; method: string; params: unknown }>;
  subscriptions: Array<{ server: string; detach: () => void }>;
  emit: (server: string, notification: { method: string; params?: unknown }) => void;
  nextResult: unknown;
  nextError: unknown;
} {
  const listeners = new Map<string, Set<(n: { method: string; params?: unknown }) => void>>();
  const tunnel = {
    requests: [] as Array<{ server: string; options: unknown }>,
    notifications: [] as Array<{ server: string; method: string; params: unknown }>,
    subscriptions: [] as Array<{ server: string; detach: () => void }>,
    nextResult: { ok: true } as unknown,
    nextError: undefined as unknown,
    emit(server: string, notification: { method: string; params?: unknown }) {
      for (const cb of [...(listeners.get(server) ?? [])]) cb(notification);
    },
    sendRequest(server: string, options: unknown) {
      tunnel.requests.push({ server, options });
      return tunnel.nextError !== undefined ? Promise.reject(tunnel.nextError) : Promise.resolve(tunnel.nextResult);
    },
    sendNotification(server: string, method: string, params?: unknown) {
      tunnel.notifications.push({ server, method, params });
    },
    subscribeNotifications(server: string, cb: (n: { method: string; params?: unknown }) => void) {
      let set = listeners.get(server);
      if (!set) {
        set = new Set();
        listeners.set(server, set);
      }
      set.add(cb);
      const detach = (): void => {
        set!.delete(cb);
      };
      tunnel.subscriptions.push({ server, detach });
      return detach;
    },
  };
  return tunnel;
}

function lookupOf(name: string, up = true, clientId = 'pc-1'): LookupResult {
  return { connection: { clientId, ws: { readyState: 1, send: () => undefined, close: () => undefined }, servers: new Set([name]) }, info: info(name), up };
}

describe('TunnelUpstream.info', () => {
  it('throws proxyError(offline) when no entry exists', () => {
    const upstream = new TunnelUpstream('files', fakeRegistry(new Map()), () => fakeTunnel());
    try {
      upstream.info;
      expect.unreachable();
    } catch (error) {
      expect(isProxyError(error)).toBe(true);
      expect((error as { code?: number }).code).toBe(PROXY_ERROR_CODE);
      expect((error as { data?: unknown }).data).toMatchObject({ source: PROXY_ERROR_SOURCE, reason: 'offline' });
    }
    expect(upstream.available).toBe(false);
  });

  it('throws proxyError(server_down) when the entry is registered but down', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files', false)]]));
    const upstream = new TunnelUpstream('files', registry, () => fakeTunnel());
    try {
      upstream.info;
      expect.unreachable();
    } catch (error) {
      expect(isProxyError(error)).toBe(true);
      expect((error as { reason?: string }).reason).toBe('server_down');
      expect((error as { data?: { reason?: string } }).data).toMatchObject({ source: PROXY_ERROR_SOURCE, reason: 'server_down' });
    }
    expect(upstream.available).toBe(false);
  });

  it('returns entry.info when up', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const upstream = new TunnelUpstream('files', registry, () => fakeTunnel());
    expect(upstream.info).toEqual(info('files'));
    expect(upstream.name).toBe('files');
    expect(upstream.available).toBe(true);
  });

  it('re-reads the registry on every access instead of caching', () => {
    const registry = fakeRegistry(new Map());
    const upstream = new TunnelUpstream('files', registry, () => fakeTunnel());
    expect(upstream.info).toBeUndefined; // no throw assertion needed here
    expect(() => upstream.info).toThrow(/no tunnel is serving/);
    registry.entries.set('files', lookupOf('files'));
    expect(upstream.info).toEqual(info('files'));
    registry.entries.set('files', lookupOf('files', false));
    expect(() => upstream.info).toThrow(/registered but down/);
  });
});

describe('TunnelUpstream.request', () => {
  it('forwards method, params, sessionId, signal, timeoutMs and onProgress', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    tunnel.nextResult = { tools: [] };
    const upstream = new TunnelUpstream('files', registry, () => tunnel);
    const signal = new AbortController().signal;
    const onProgress = vi.fn();

    const result = await upstream.request('tools/call', { name: 'read' }, { sessionId: 'sess-1', signal, timeoutMs: 1234, onProgress });

    expect(result).toEqual({ tools: [] });
    expect(tunnel.requests).toHaveLength(1);
    expect(tunnel.requests[0]).toEqual({
      server: 'files',
      options: { method: 'tools/call', params: { name: 'read' }, sessionId: 'sess-1', signal, timeoutMs: 1234, wantProgress: true, onProgress },
    });
  });

  it('omits absent optional fields and does not ask for progress when nobody listens', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const upstream = new TunnelUpstream('files', registry, () => tunnel);

    await upstream.request('ping');

    expect(tunnel.requests[0]?.options).toEqual({ method: 'ping' });
  });

  it('resolves the current tunnel per call so a reconnect is picked up', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const first = fakeTunnel();
    const second = fakeTunnel();
    let current: TunnelUpstreamTransport = first;
    const upstream = new TunnelUpstream('files', registry, () => current);

    await upstream.request('ping');
    current = second;
    await upstream.request('ping');

    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('rejects with offline when the name has no entry', async () => {
    const upstream = new TunnelUpstream('files', fakeRegistry(new Map()), () => fakeTunnel());
    await expect(upstream.request('ping')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('rejects with server_down when the entry is down', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files', false)]]));
    const upstream = new TunnelUpstream('files', registry, () => fakeTunnel());
    await expect(upstream.request('ping')).rejects.toMatchObject({ reason: 'server_down' });
  });

  it('rejects with offline when the registry entry has no live tunnel', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const upstream = new TunnelUpstream('files', registry, () => undefined);
    await expect(upstream.request('ping')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('rethrows an UpstreamRpcError unchanged (same object, raw code/message/data)', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const rpcError = new UpstreamRpcError({ code: -32602, message: 'no such tool', data: { tool: 'ghost' } });
    tunnel.nextError = rpcError;
    const upstream = new TunnelUpstream('files', registry, () => tunnel);

    const caught = await upstream.request('tools/call').catch((error: unknown) => error);

    expect(caught).toBe(rpcError);
    expect(isUpstreamRpcError(caught)).toBe(true);
    expect(caught).toMatchObject({ code: -32602, message: 'no such tool', data: { tool: 'ghost' } });
    // Not a proxy error: the endpoint must relay the upstream code verbatim.
    expect(isProxyError(caught)).toBe(false);
  });

  it('lets a tunnel ProxyError (client_disconnected) through unchanged', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const dropped = Object.assign(new Error('the tunnel connection dropped'), {
      name: 'ProxyError',
      reason: 'client_disconnected',
      code: PROXY_ERROR_CODE,
      data: { source: PROXY_ERROR_SOURCE, reason: 'client_disconnected' },
    });
    tunnel.nextError = dropped;
    const upstream = new TunnelUpstream('files', registry, () => tunnel);
    await expect(upstream.request('ping')).rejects.toBe(dropped);
  });
});

describe('TunnelUpstream.notification', () => {
  it('sends a notification frame on the current tunnel', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const upstream = new TunnelUpstream('files', registry, () => tunnel);

    await upstream.notification('notifications/cancelled', { requestId: 1 });

    expect(tunnel.notifications).toEqual([{ server: 'files', method: 'notifications/cancelled', params: { requestId: 1 } }]);
  });

  it('throws proxyError(offline) with no live connection', async () => {
    const upstream = new TunnelUpstream('files', fakeRegistry(new Map()), () => fakeTunnel());
    await expect(upstream.notification('notifications/cancelled')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('throws proxyError(offline) when the connection is gone but the name is still registered', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const upstream = new TunnelUpstream('files', registry, () => undefined);
    try {
      await upstream.notification('notifications/cancelled');
      expect.unreachable();
    } catch (error) {
      expect(isProxyError(error)).toBe(true);
      expect((error as { reason?: string }).reason).toBe('offline');
    }
  });
});

describe('TunnelUpstream.subscribe', () => {
  it('delivers notifications for this name and unsubscribes', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const upstream = new TunnelUpstream('files', registry, () => tunnel);
    const seen: unknown[] = [];
    const off = upstream.subscribe((n) => seen.push(n));

    tunnel.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toEqual([{ method: 'notifications/tools/list_changed' }]);

    off();
    tunnel.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(1);
  });

  it('never delivers another server name\'s notifications', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const upstream = new TunnelUpstream('files', registry, () => tunnel);
    const seen: unknown[] = [];
    upstream.subscribe((n) => seen.push(n));

    tunnel.emit('other', { method: 'notifications/tools/list_changed' });
    expect(seen).toEqual([]);
  });

  it('a throwing subscriber does not break the tunnel or the other subscribers', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnel = fakeTunnel();
    const upstream = new TunnelUpstream('files', registry, () => tunnel);
    const second = vi.fn();
    upstream.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    upstream.subscribe(second);

    expect(() => tunnel.emit('files', { method: 'notifications/message' })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('re-binds to the new tunnel after a reconnect', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const first = fakeTunnel();
    const second = fakeTunnel();
    let current: TunnelUpstreamTransport = first;
    const upstream = new TunnelUpstream('files', registry, () => current);
    const seen: unknown[] = [];
    upstream.subscribe((n) => seen.push(n));

    // Reconnect: a fresh tunnel takes over the same name.
    current = second;
    upstream.rebind();

    second.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(1);

    // The old tunnel's subscription was detached, so nothing arrives from it.
    first.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(1);
  });
});

describe('TunnelUpstreams / createTunnelUpstreamFactory', () => {
  it('hands out the same object per name across calls', () => {
    const registry = fakeRegistry(new Map());
    const manager = new TunnelUpstreams(registry);
    expect(manager.get('files')).toBe(manager.get('files'));
    expect(manager.get('other')).not.toBe(manager.get('files'));
    expect(manager.list().map((u) => u.name)).toEqual(['files', 'other']);
  });

  it('the factory hands out one stable upstream per name', () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const upstreamFor = createTunnelUpstreamFactory(registry);
    const upstream = upstreamFor('files');
    expect(upstreamFor('files')).toBe(upstream);
    expect(upstream.info).toEqual(info('files'));
  });

  it('resolves the tunnel through the shared connection map', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const first = fakeTunnel();
    const tunnels = new Map<string, TunnelUpstreamTransport>([['pc-1', first]]);
    const upstream = new TunnelUpstreams(registry, tunnels).get('files');

    await upstream.request('ping');
    expect(first.requests).toHaveLength(1);

    // The connection dies: the name goes offline until a new tunnel is tracked.
    tunnels.delete('pc-1');
    await expect(upstream.request('ping')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('track()/untrack() re-bind subscriptions so notifications survive a reconnect', async () => {
    const registry = fakeRegistry(new Map([['files', lookupOf('files')]]));
    const tunnels = new Map<string, TunnelUpstreamTransport>();
    const manager = new TunnelUpstreams(registry, tunnels);
    const upstream = manager.get('files');
    const seen: unknown[] = [];
    upstream.subscribe((n) => seen.push(n));

    const first = fakeTunnel();
    manager.track('pc-1', first);
    first.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(1);

    // Reconnect: same clientId, brand-new tunnel object.
    const second = fakeTunnel();
    manager.track('pc-1', second);
    second.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(2);
    first.emit('files', { method: 'notifications/tools/list_changed' });
    expect(seen).toHaveLength(2);

    manager.untrack('pc-1');
    await expect(upstream.request('ping')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('drop() stops handing out the cached handle', () => {
    const registry = fakeRegistry(new Map());
    const manager = new TunnelUpstreams(registry);
    const before = manager.get('files');
    manager.drop('files');
    expect(manager.get('files')).not.toBe(before);
    expect(manager.list()).toHaveLength(1);
  });
});

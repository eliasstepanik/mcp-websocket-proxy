import { describe, expect, it } from 'vitest';

import {
  CLOSE_CODE_REPLACED,
  REASON_CONNECTION_LOST,
  Registry,
  RegistryError,
  type RegistryEvent,
  type WsLike,
} from '../../src/server/registry.js';
import type { UpstreamInfo } from '../../src/shared/upstream.js';

/** A fake socket: no real transport, just enough shape for the registry. */
function fakeWs(readyState = 1): WsLike & { closed: Array<{ code?: number; reason?: string }> } {
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    readyState,
    send: () => {
      throw new Error('registry must not write to the socket');
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    closed,
  };
}

const info = (name: string): UpstreamInfo => ({
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name, version: '1.0.0' },
});

describe('registerConnection', () => {
  it('records a connection and exposes it', () => {
    const registry = new Registry();
    const ws = fakeWs();
    const { connection, replaced } = registry.registerConnection('pc-1', ws);

    expect(replaced).toBeUndefined();
    expect(connection.clientId).toBe('pc-1');
    expect(connection.ws).toBe(ws);
    expect(connection.servers.size).toBe(0);
    expect(registry.get('pc-1')).toBe(connection);
    expect(registry.connections()).toEqual([connection]);
    expect(registry.connectionCount).toBe(1);
  });

  it('replaces a connection with the same clientId and reports it', () => {
    const registry = new Registry();
    const first = registry.registerConnection('pc-1', fakeWs()).connection;
    const secondWs = fakeWs();
    const { connection: second, replaced } = registry.registerConnection('pc-1', secondWs);

    expect(replaced).toBe(first);
    expect(registry.connectionCount).toBe(1);
    expect(registry.get('pc-1')).toBe(second);
    expect(second.ws).toBe(secondWs);

    // The caller closes the replaced socket with the dedicated close code.
    replaced?.ws.close(CLOSE_CODE_REPLACED, 'replaced by a newer connection');
    expect(first.ws).toHaveProperty('closed', [{ code: 4002, reason: 'replaced by a newer connection' }]);
  });

  it('keeps server ownership across a replace so a reconnect may re-register', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    expect(registry.markServerUp('pc-1', 'files', info('files'))).toEqual({ ok: true });

    const { replaced } = registry.registerConnection('pc-1', fakeWs());
    expect(replaced?.servers.has('files')).toBe(true);

    // Same name, same clientId: not a conflict, just a refresh.
    const refreshed = info('files');
    expect(registry.markServerUp('pc-1', 'files', refreshed)).toEqual({ ok: true });
    expect(registry.lookup('files')).toMatchObject({ up: true, info: refreshed });
  });
});

describe('markServerUp', () => {
  it('rejects a name that does not match SERVER_NAME_RE', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());

    expect(registry.markServerUp('pc-1', 'Bad Name', info('x'))).toEqual({ ok: false, error: 'invalid_name' });
    expect(registry.markServerUp('pc-1', '-lead', info('x'))).toEqual({ ok: false, error: 'invalid_name' });
    expect(registry.markServerUp('pc-1', 'a'.repeat(64), info('x'))).toEqual({ ok: false, error: 'invalid_name' });
    expect(registry.markServerUp('pc-1', 'a'.repeat(63), info('x'))).toEqual({ ok: true });
    expect(registry.lookup('a'.repeat(63))).toMatchObject({ up: true });
  });

  it('gives the name to the first registrant and rejects others with name_conflict', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    registry.registerConnection('pc-2', fakeWs());

    expect(registry.markServerUp('pc-1', 'files', info('files'))).toEqual({ ok: true });
    expect(registry.markServerUp('pc-2', 'files', info('files'))).toEqual({ ok: false, error: 'name_conflict' });
    expect(registry.lookup('files')).toMatchObject({ up: true, connection: { clientId: 'pc-1' } });
  });

  it('checks the name before the conflict', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    registry.registerConnection('pc-2', fakeWs());
    registry.markServerUp('pc-1', 'Files', info('x'));
    expect(registry.markServerUp('pc-2', 'Files', info('x'))).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('throws for a clientId that never registered', () => {
    const registry = new Registry();
    expect(() => registry.markServerUp('ghost', 'files', info('files'))).toThrow(RegistryError);
  });
});

describe('markServerDown / lookup', () => {
  it('marks a server down but keeps the name owned', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    registry.markServerUp('pc-1', 'files', info('files'));

    expect(registry.markServerDown('pc-1', 'files', 'upstream exited')).toBe(true);
    expect(registry.lookup('files')).toMatchObject({ up: false });
    expect(registry.get('pc-1')?.servers.has('files')).toBe(true);

    // Already down, unknown name and wrong owner all report false.
    expect(registry.markServerDown('pc-1', 'files', 'again')).toBe(false);
    expect(registry.markServerDown('pc-1', 'never', 'x')).toBe(false);
    registry.registerConnection('pc-2', fakeWs());
    expect(registry.markServerUp('pc-2', 'files', info('files'))).toEqual({ ok: false, error: 'name_conflict' });
  });

  it('lookup returns undefined for an unknown name', () => {
    const registry = new Registry();
    expect(registry.lookup('nope')).toBeUndefined();
  });
});

describe('listServers', () => {
  it('lists every registered server sorted by name', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    registry.registerConnection('pc-2', fakeWs());
    registry.markServerUp('pc-2', 'beta', info('beta'));
    registry.markServerUp('pc-1', 'alpha', info('alpha'));
    registry.markServerDown('pc-2', 'beta', 'crashed');

    const rows = registry.listServers();
    expect(rows.map((row) => [row.name, row.clientId, row.up])).toEqual([
      ['alpha', 'pc-1', true],
      ['beta', 'pc-2', false],
    ]);
    expect(rows[0]?.info).toEqual(info('alpha'));
    expect(registry.serverCount).toBe(2);
  });
});

describe('events', () => {
  it('fires server_up then server_down in registration order', () => {
    const registry = new Registry();
    const events: RegistryEvent[] = [];
    const off = registry.on((event) => events.push(event));
    registry.registerConnection('pc-1', fakeWs());

    registry.markServerUp('pc-1', 'files', info('files'));
    registry.markServerUp('pc-1', 'other', info('other'));
    registry.markServerDown('pc-1', 'files', 'upstream exited');

    expect(events).toEqual([
      { type: 'server_up', clientId: 'pc-1', server: 'files', info: info('files') },
      { type: 'server_up', clientId: 'pc-1', server: 'other', info: info('other') },
      { type: 'server_down', clientId: 'pc-1', server: 'files', reason: 'upstream exited' },
    ]);

    off();
    registry.markServerDown('pc-1', 'other', 'bye');
    expect(events).toHaveLength(3);
  });
});

describe('unregisterConnection', () => {
  it('marks the connection servers down and emits connection_lost', () => {
    const registry = new Registry();
    const events: RegistryEvent[] = [];
    registry.on((event) => events.push(event));
    registry.registerConnection('pc-1', fakeWs());
    registry.markServerUp('pc-1', 'files', info('files'));
    registry.markServerUp('pc-1', 'other', info('other'));
    registry.markServerDown('pc-1', 'other', 'already down');
    events.length = 0;

    const removed = registry.unregisterConnection('pc-1');
    expect(removed?.clientId).toBe('pc-1');
    expect(registry.get('pc-1')).toBeUndefined();
    expect(registry.connectionCount).toBe(0);
    expect(registry.serverCount).toBe(0);
    expect(registry.lookup('files')).toBeUndefined();
    expect(registry.lookup('other')).toBeUndefined();
    expect(events).toEqual([
      { type: 'server_down', clientId: 'pc-1', server: 'files', reason: REASON_CONNECTION_LOST },
      { type: 'connection_lost', clientId: 'pc-1', servers: ['files', 'other'] },
    ]);
  });

  it('releases the names so another client may claim them', () => {
    const registry = new Registry();
    registry.registerConnection('pc-1', fakeWs());
    registry.markServerUp('pc-1', 'files', info('files'));
    registry.unregisterConnection('pc-1');

    registry.registerConnection('pc-2', fakeWs());
    expect(registry.markServerUp('pc-2', 'files', info('files'))).toEqual({ ok: true });
    expect(registry.lookup('files')).toMatchObject({ up: true, connection: { clientId: 'pc-2' } });
  });

  it('accepts a custom reason and tolerates an unknown clientId', () => {
    const registry = new Registry();
    const events: RegistryEvent[] = [];
    registry.on((event) => events.push(event));
    registry.registerConnection('pc-1', fakeWs());
    registry.markServerUp('pc-1', 'files', info('files'));

    expect(registry.unregisterConnection('pc-1', 'socket error')).toBeDefined();
    expect(events).toContainEqual({
      type: 'server_down',
      clientId: 'pc-1',
      server: 'files',
      reason: 'socket error',
    });
    expect(registry.unregisterConnection('ghost')).toBeUndefined();
  });
});

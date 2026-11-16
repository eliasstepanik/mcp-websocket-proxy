import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  SERVER_NAME_RE,
  TunnelProtocolError,
  parseTunnelMessage,
  type ClientToServer,
  type ServerToClient,
  type TunnelMessage,
} from '../../src/shared/protocol.js';

const serverInfo = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'files', version: '1.2.3' },
};

describe('constants', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('exposes the server-name pattern', () => {
    expect(SERVER_NAME_RE.test('main')).toBe(true);
    expect(SERVER_NAME_RE.test('a_b-c9')).toBe(true);
    expect(SERVER_NAME_RE.test('a'.repeat(63))).toBe(true);
    expect(SERVER_NAME_RE.test('')).toBe(false);
    expect(SERVER_NAME_RE.test('A')).toBe(false);
    expect(SERVER_NAME_RE.test('-lead')).toBe(false);
    expect(SERVER_NAME_RE.test('a'.repeat(64))).toBe(false);
  });
});

describe('client -> server (direction "in")', () => {
  it('parses hello', () => {
    const msg = parseTunnelMessage(
      JSON.stringify({ type: 'hello', protocol: 1, clientId: 'pc-1', clientVersion: '0.1.0' }),
      'in',
    );
    expect(msg).toEqual({ type: 'hello', protocol: 1, clientId: 'pc-1', clientVersion: '0.1.0' });
  });

  it('parses hello without the optional clientVersion', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'pc-1' }), 'in')).toEqual({
      type: 'hello',
      protocol: 1,
      clientId: 'pc-1',
    });
  });

  it('parses server_up', () => {
    const msg = parseTunnelMessage(
      JSON.stringify({ type: 'server_up', server: 'files', info: { ...serverInfo, instructions: 'be nice' } }),
      'in',
    );
    expect(msg.type).toBe('server_up');
  });

  it('parses server_down', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'server_down', server: 'files', reason: 'spawn EACCES' }), 'in')).toEqual(
      { type: 'server_down', server: 'files', reason: 'spawn EACCES' },
    );
  });

  it('parses a response carrying result', () => {
    const msg = parseTunnelMessage(JSON.stringify({ type: 'response', id: 7, result: { tools: [] } }), 'in');
    expect(msg).toEqual({ type: 'response', id: 7, result: { tools: [] } });
  });

  it('parses a response carrying a null result', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'response', id: 'a', result: null }), 'in')).toEqual({
      type: 'response',
      id: 'a',
      result: null,
    });
  });

  it('parses a response carrying error', () => {
    const msg = parseTunnelMessage(
      JSON.stringify({ type: 'response', id: 3, error: { code: -32601, message: 'no such tool', data: { x: 1 } } }),
      'in',
    );
    expect(msg.type).toBe('response');
  });

  it('parses progress', () => {
    expect(
      parseTunnelMessage(JSON.stringify({ type: 'progress', id: 1, params: { progress: 3, total: 10, message: 'half' } }), 'in'),
    ).toEqual({ type: 'progress', id: 1, params: { progress: 3, total: 10, message: 'half' } });
  });

  it('parses notification', () => {
    expect(
      parseTunnelMessage(JSON.stringify({ type: 'notification', server: 'files', method: 'notifications/initialized' }), 'in'),
    ).toEqual({ type: 'notification', server: 'files', method: 'notifications/initialized' });
  });
});

describe('server -> client (direction "out")', () => {
  it('parses welcome', () => {
    expect(
      parseTunnelMessage(JSON.stringify({ type: 'welcome', protocol: 1, serverVersion: '0.1.0', heartbeatIntervalMs: 15_000 }), 'out'),
    ).toEqual({ type: 'welcome', protocol: 1, serverVersion: '0.1.0', heartbeatIntervalMs: 15_000 });
  });

  it('parses server_ack ok and server_ack with error', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'server_ack', server: 'files', ok: true }), 'out')).toEqual({
      type: 'server_ack',
      server: 'files',
      ok: true,
    });
    expect(
      parseTunnelMessage(JSON.stringify({ type: 'server_ack', server: 'files', ok: false, error: 'invalid_name' }), 'out').type,
    ).toBe('server_ack');
  });

  it('parses request', () => {
    const msg = parseTunnelMessage(
      JSON.stringify({
        type: 'request',
        id: 42,
        server: 'files',
        session: 'sess-1',
        method: 'tools/call',
        params: { name: 'read', arguments: {} },
        wantProgress: true,
      }),
      'out',
    );
    expect(msg).toMatchObject({ type: 'request', id: 42, server: 'files', method: 'tools/call', wantProgress: true });
  });

  it('parses cancel', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'cancel', id: 'r1', reason: 'client gone' }), 'out')).toEqual({
      type: 'cancel',
      id: 'r1',
      reason: 'client gone',
    });
  });
});

describe('rejections', () => {
  it('rejects malformed JSON', () => {
    expect(() => parseTunnelMessage('{"type":"hello",', 'in')).toThrow(TunnelProtocolError);
    expect(() => parseTunnelMessage('not json', 'in')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON value that is not an object', () => {
    expect(() => parseTunnelMessage('"hello"', 'in')).toThrow(TunnelProtocolError);
    expect(() => parseTunnelMessage('null', 'out')).toThrow(TunnelProtocolError);
  });

  it('rejects an unknown type', () => {
    expect(() => parseTunnelMessage(JSON.stringify({ type: 'pwn' }), 'in')).toThrow(/Invalid discriminator value/);
  });

  it('rejects a wrong protocol version', () => {
    expect(() =>
      parseTunnelMessage(JSON.stringify({ type: 'hello', protocol: 2, clientId: 'pc-1' }), 'in'),
    ).toThrow(/protocol/);
    expect(() =>
      parseTunnelMessage(JSON.stringify({ type: 'welcome', protocol: 0, heartbeatIntervalMs: 1000 }), 'out'),
    ).toThrow(/protocol/);
  });

  it('rejects a bad server name', () => {
    expect(() =>
      parseTunnelMessage(JSON.stringify({ type: 'server_down', server: 'Bad Name', reason: 'x' }), 'in'),
    ).toThrow(/server/);
    expect(() =>
      parseTunnelMessage(JSON.stringify({ type: 'request', id: 1, server: 'Bad Name', method: 'ping' }), 'out'),
    ).toThrow(/server/);
  });

  it('rejects a response with both result and error', () => {
    expect(() =>
      parseTunnelMessage(
        JSON.stringify({ type: 'response', id: 1, result: {}, error: { code: 1, message: 'm' } }),
        'in',
      ),
    ).toThrow(/exactly one of/);
  });

  it('rejects a response with neither result nor error', () => {
    expect(() => parseTunnelMessage(JSON.stringify({ type: 'response', id: 1 }), 'in')).toThrow(/exactly one of/);
  });

  it('rejects a message that is valid but in the wrong direction', () => {
    expect(() => parseTunnelMessage(JSON.stringify({ type: 'hello', protocol: 1, clientId: 'pc' }), 'out')).toThrow(
      TunnelProtocolError,
    );
    expect(
      () => parseTunnelMessage(JSON.stringify({ type: 'welcome', protocol: 1, heartbeatIntervalMs: 1000 }), 'in'),
    ).toThrow(TunnelProtocolError);
  });

  it('reports the offending path in the error message', () => {
    let caught: unknown;
    try {
      parseTunnelMessage(JSON.stringify({ type: 'progress', id: 1, params: { progress: 'lots' } }), 'in');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TunnelProtocolError);
    expect((caught as Error).message).toContain('params.progress');
  });
});

describe('types are assignable both ways', () => {
  it('narrows per-direction unions through TunnelMessage', () => {
    const inFrame: ClientToServer = { type: 'server_down', server: 'files', reason: 'bye' };
    const outFrame: ServerToClient = { type: 'cancel', id: 1 };
    const both: TunnelMessage[] = [inFrame, outFrame];
    const parsed: TunnelMessage = parseTunnelMessage(JSON.stringify(outFrame), 'out');
    expect(both).toHaveLength(2);
    expect(parsed.type).toBe('cancel');
  });
});

/**
 * Unit tests for `src/server/auth.ts`: the bearer parser and the constant-time
 * comparison.
 *
 * The cases mirror how a real client can get it wrong (lower-case scheme is legal
 * per RFC 7235, a token that merely *starts* with the right one is not).
 */

import { describe, expect, it } from 'vitest';

import { bearerHeader, verifyBearer } from '../../src/server/auth.js';

const TOKEN = 'a-very-long-tunnel-token-0123456789';

describe('verifyBearer', () => {
  it('accepts the exact token', () => {
    expect(verifyBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('accepts a case-insensitive scheme and extra spacing', () => {
    expect(verifyBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`Bearer  ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyBearer(undefined, TOKEN)).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(verifyBearer('', TOKEN)).toBe(false);
  });

  it('rejects the wrong scheme', () => {
    expect(verifyBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(verifyBearer(TOKEN, TOKEN)).toBe(false);
    expect(verifyBearer(`Token ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a bearer header with no token', () => {
    expect(verifyBearer('Bearer', TOKEN)).toBe(false);
    expect(verifyBearer('Bearer ', TOKEN)).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(verifyBearer('Bearer nope-not-the-token-at-all-1234567890', TOKEN)).toBe(false);
  });

  it('rejects a prefix or a superstring of the token', () => {
    expect(verifyBearer('Bearer a-very-long-tunnel-token', TOKEN)).toBe(false);
    expect(verifyBearer(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
  });

  it('rejects the other audience token (caller passes the wrong expectation)', () => {
    const other = 'a-different-endpoint-token-0123456789';
    expect(verifyBearer(bearerHeader(TOKEN), other)).toBe(false);
  });

  it('rejects everything when no token is configured', () => {
    expect(verifyBearer('Bearer ', '')).toBe(false);
    expect(verifyBearer('Bearer anything', '')).toBe(false);
  });
});

/**
 * Bearer-token authentication (T3).
 *
 * Two audiences, one mechanism: a tunnel client and Warren itself both present
 * `Authorization: Bearer <token>`, and each is compared against its own configured
 * token (see `src/server/config.ts`).
 *
 * The comparison is constant-time: both sides are hashed with SHA-256 first, so
 * `crypto.timingSafeEqual` gets two equal-length buffers (it throws otherwise) and
 * leaks neither the length nor a per-byte prefix match. Hashing does not weaken the
 * comparison — an attacker who can brute-force the hash still has to invert SHA-256.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Shortest token accepted; mirrors `MIN_TOKEN_LENGTH` in `config.ts`. */
export const MIN_TOKEN_LENGTH = 32;

/** `Bearer` is case-insensitive per RFC 7235; the token itself is not. */
const BEARER_RE = /^Bearer[ \t]+(.+)$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when `header` is exactly `Bearer <expected>`.
 *
 * Anything else — no header, another scheme, an empty token, a wrong token, a
 * longer token that merely starts with the right one — is false. Never log the
 * header: it carries the secret.
 */
export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (header === undefined || expected === '') return false;
  const match = BEARER_RE.exec(header);
  const presented = match?.[1]?.trim();
  if (presented === undefined || presented === '') return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/** The `Authorization` value a client should send. */
export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}

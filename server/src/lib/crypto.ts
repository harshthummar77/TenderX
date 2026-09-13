import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Token and hashing helpers. Password hashing is bcryptjs and lives in the auth
 * module (plan 03) — this file is for opaque tokens, document seals and the
 * audit hash chain.
 */

/** URL-safe opaque token. Used for refresh tokens, invitations, password resets. */
export const randomToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');

/**
 * Refresh tokens, invitation tokens and reset tokens are stored HASHED. A stolen
 * database dump must not yield usable tokens.
 */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Canonical JSON hash — the seal on a sealed bid (plan 08) and the audit chain link (plan 14). */
export const hashObject = (value: unknown): string => sha256(JSON.stringify(value));

/** Constant-time comparison for anything secret. Never use `===` on a token. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const newId = (): string => randomUUID();

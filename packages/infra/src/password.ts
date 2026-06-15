import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Derived-key length in bytes. */
const KEY_LEN = 64;
/** Salt length in bytes. */
const SALT_LEN = 16;

/**
 * Hash a password with scrypt (`node:crypto`, no native build deps) into a
 * self-describing `scrypt$<saltHex>$<hashHex>` string. A fresh random salt is
 * generated per call, so two hashes of the same password differ. Only this
 * string is stored; the plaintext password is never persisted or logged.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a candidate password against a `scrypt$<salt>$<hash>` string produced
 * by {@link hashPassword}. Re-derives the key with the stored salt and compares
 * in constant time via `timingSafeEqual`. Returns `false` (never throws) for a
 * malformed stored value or a length mismatch, so callers can treat any
 * non-`true` result as a failed login.
 */
export function verifyPassword(stored: string, candidate: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, saltHex, hashHex] = parts;
  if (saltHex === undefined || hashHex === undefined || saltHex === '' || hashHex === '') {
    return false;
  }

  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  const derived = scryptSync(candidate, salt, expected.length);
  // timingSafeEqual throws on differing lengths — guard it explicitly so a
  // truncated/forged hash fails closed rather than erroring.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

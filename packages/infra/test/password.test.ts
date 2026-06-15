import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/password.js';

describe('password hashing (scrypt)', () => {
  it('produces a scrypt$<salt>$<hash> string', () => {
    const stored = hashPassword('correct horse battery staple');
    const parts = stored.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(3);
    // salt + hash are non-empty lowercase hex.
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('round-trips: verifyPassword true for the right password', () => {
    const stored = hashPassword('s3cret-pw');
    expect(verifyPassword(stored, 's3cret-pw')).toBe(true);
  });

  it('verifyPassword false for the wrong password', () => {
    const stored = hashPassword('s3cret-pw');
    expect(verifyPassword(stored, 'not-the-password')).toBe(false);
  });

  it('uses a random salt: two hashes of the same password differ', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    // ...but both still verify.
    expect(verifyPassword(a, 'same')).toBe(true);
    expect(verifyPassword(b, 'same')).toBe(true);
  });

  it('returns false (never throws) on a malformed stored value', () => {
    expect(verifyPassword('not-a-valid-hash', 'pw')).toBe(false);
    expect(verifyPassword('scrypt$onlyonepart', 'pw')).toBe(false);
    expect(verifyPassword('', 'pw')).toBe(false);
  });

  it('rejects a candidate whose hash length differs (no timingSafeEqual throw)', () => {
    // A stored hash of a different byte length must not throw inside
    // timingSafeEqual; it just fails verification.
    const stored = `scrypt$aabb$${'00'.repeat(16)}`; // 16-byte hash, not 64
    expect(verifyPassword(stored, 'pw')).toBe(false);
  });
});

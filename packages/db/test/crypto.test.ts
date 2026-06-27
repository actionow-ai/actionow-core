import { createCipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../src/crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64'); // 32-byte key, base64
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

/** Re-create the PRE-versioning `iv.tag.ciphertext` blob (no version, no AAD). */
function legacyEncrypt(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

describe('secret crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const material = encryptSecret('sk-secret-value', KEY);
    expect(material).not.toContain('sk-secret-value'); // ciphertext, not plaintext
    expect(material.split('.')).toHaveLength(4); // v1.iv.tag.ciphertext (base64 parts)
    expect(decryptSecret(material, KEY)).toBe('sk-secret-value');
  });

  it('uses a fresh iv per call (same plaintext → different material)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const m = encryptSecret('x', KEY);
    const parts = m.split('.');
    parts[3] = Buffer.from('zzzz').toString('base64');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
  });

  it('throws on a non-32-byte key', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow(/32/);
  });
});

describe('crypto envelope (versioning + AAD)', () => {
  it('writes a versioned v1 envelope', () => {
    const blob = encryptSecret('sk-secret', KEY);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob.split('.')).toHaveLength(4);
  });

  it('round-trips with AAD when the AAD matches', () => {
    const aad = 'secret-ref-id-123';
    const blob = encryptSecret('sk-secret', KEY, aad);
    expect(decryptSecret(blob, KEY, aad)).toBe('sk-secret');
  });

  it('rejects a v1 envelope when the AAD does not match (anti-swap pinning)', () => {
    const blob = encryptSecret('sk-secret', KEY, 'ref-A');
    expect(() => decryptSecret(blob, KEY, 'ref-B')).toThrow();
    // a blob bound to an AAD must NOT decrypt without it
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('still decrypts a legacy 3-part blob (backward compatible, no AAD)', () => {
    const legacy = legacyEncrypt('legacy-secret', KEY);
    expect(legacy.split('.')).toHaveLength(3);
    expect(decryptSecret(legacy, KEY)).toBe('legacy-secret');
  });

  it('throws on the wrong key', () => {
    const blob = encryptSecret('sk-secret', KEY);
    expect(() => decryptSecret(blob, OTHER_KEY)).toThrow();
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptSecret('not-a-valid-blob', KEY)).toThrow('malformed secret material');
  });
});

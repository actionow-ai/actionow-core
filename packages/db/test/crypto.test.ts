import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../src/crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64'); // 32-byte key, base64

describe('secret crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const material = encryptSecret('sk-secret-value', KEY);
    expect(material).not.toContain('sk-secret-value'); // ciphertext, not plaintext
    expect(material.split('.')).toHaveLength(3); // iv.tag.ciphertext (base64 parts)
    expect(decryptSecret(material, KEY)).toBe('sk-secret-value');
  });

  it('uses a fresh iv per call (same plaintext → different material)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const m = encryptSecret('x', KEY);
    const [, ivPart, tagPart] = /^([^.]+)\.([^.]+)\./.exec(m) ?? [];
    if (typeof ivPart !== 'string' || typeof tagPart !== 'string') {
      throw new Error('unexpected material format');
    }
    const tampered = `${ivPart}.${tagPart}.${Buffer.from('zzzz').toString('base64')}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws on a non-32-byte key', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow(/32/);
  });
});

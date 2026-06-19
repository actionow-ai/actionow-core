import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/** Decode + validate the base64 master key as exactly 32 bytes (AES-256). */
function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`secret encryption key must be 32 bytes (got ${String(key.length)})`);
  }
  return key;
}

/**
 * Encrypt `plaintext` to a self-describing `iv.tag.ciphertext` string (each part
 * base64). A fresh random IV per call; GCM auth tag detects tampering on decrypt.
 */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/** Inverse of {@link encryptSecret}; throws on a bad key, malformed input, or tampering. */
export function decryptSecret(material: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const parts = material.split('.');
  if (parts.length !== 3) throw new Error('malformed secret material');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

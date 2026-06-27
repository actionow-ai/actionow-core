import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
/**
 * Current envelope version. `v1` = AES-256-GCM, AAD-bound, master key #1. The
 * leading token doubles as a KEY-ID so a future key rotation can introduce `v2`
 * ciphertext (encrypted under a new key) while existing `v1`/legacy rows keep
 * decrypting under the old key — lazy rotation, no decrypt-all/re-encrypt-all.
 */
const VERSION = 'v1';

/** Decode + validate the base64 master key as exactly 32 bytes (AES-256). */
function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`secret encryption key must be 32 bytes (got ${String(key.length)})`);
  }
  return key;
}

/**
 * Encrypt `plaintext` to a self-describing `v1.iv.tag.ciphertext` envelope (each
 * part base64). A fresh random IV per call; the GCM auth tag detects tampering on
 * decrypt.
 *
 * `aad` (additional authenticated data) is folded into the GCM tag so the
 * ciphertext is cryptographically PINNED to its location: pass the row's stable
 * id (e.g. the `secret_ref` id) and a blob copied to a DIFFERENT row fails to
 * decrypt (an attacker with DB-write access can't swap ciphertext between rows).
 * Omitting `aad` binds the empty string (still versioned + tamper-evident).
 */
export function encryptSecret(plaintext: string, keyB64: string, aad = ''): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/**
 * Inverse of {@link encryptSecret}. Accepts BOTH the versioned `v1.iv.tag.ct`
 * envelope (AAD-bound) and the legacy `iv.tag.ct` 3-part form (pre-versioning, no
 * AAD) so ciphertext written before this change keeps decrypting unchanged. For a
 * `v1` envelope `aad` MUST match what was supplied at encrypt time. Throws on a
 * bad key, malformed input, AAD mismatch, or tampering.
 */
export function decryptSecret(material: string, keyB64: string, aad = ''): string {
  const key = decodeKey(keyB64);
  const parts = material.split('.');
  // Legacy (pre-versioning): iv.tag.ct, decrypted WITHOUT AAD.
  if (parts.length === 3) {
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    return gcmDecrypt(key, ivB64, tagB64, ctB64, undefined);
  }
  // Versioned envelope: <ver>.iv.tag.ct.
  if (parts.length === 4 && parts[0] === VERSION) {
    const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    return gcmDecrypt(key, ivB64, tagB64, ctB64, aad);
  }
  throw new Error('malformed secret material');
}

/** GCM-decrypt the three base64 parts; bind `aad` only when present (v1). */
function gcmDecrypt(
  key: Buffer,
  ivB64: string,
  tagB64: string,
  ctB64: string,
  aad: string | undefined,
): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

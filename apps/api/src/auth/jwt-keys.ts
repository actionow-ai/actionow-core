import type { AppEnv } from '@actionow/infra';
import {
  calculateJwkThumbprint,
  exportJWK,
  importPKCS8,
  importSPKI,
  type JWK,
  type KeyLike,
} from 'jose';

/**
 * Decode a PEM that may have arrived base64-encoded (the env-friendly form, since
 * a raw PEM's newlines are awkward in env files). If the value already looks like
 * PEM (`-----BEGIN`), it is returned as-is; otherwise it is base64-decoded.
 */
export function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

/** The resolved RS256 key material + the kid stamped on tokens + published in the JWKS. */
export interface Rs256Keys {
  readonly privateKey: KeyLike;
  readonly publicKey: KeyLike;
  /** The published JWK (public half only), carrying `kid`/`use`/`alg`. */
  readonly publicJwk: JWK;
  readonly kid: string;
}

/**
 * Build the RS256 key material from env (PEM or base64-PEM). The public key is
 * DERIVED from the private key when `JWT_PUBLIC_KEY` is unset. The `kid` is
 * `JWT_KID` when set, else the public key's RFC-7638 JWK thumbprint (stable per
 * key, so adding a second key under a new kid is non-breaking). NEVER returns or
 * logs the private key material itself. Returns `null` when no private key is
 * configured (so HS256 stays the path and the JWKS is empty).
 */
export async function loadRs256Keys(env: AppEnv): Promise<Rs256Keys | null> {
  if (env.JWT_PRIVATE_KEY === undefined) return null;
  const privateKey = await importPKCS8(normalizePem(env.JWT_PRIVATE_KEY), 'RS256');

  // Derive the public key from the private key when not supplied. jose has no
  // direct private→public extractor, so round-trip through a public JWK.
  let publicKey: KeyLike;
  if (env.JWT_PUBLIC_KEY !== undefined) {
    publicKey = await importSPKI(normalizePem(env.JWT_PUBLIC_KEY), 'RS256');
  } else {
    const privJwk = await exportJWK(privateKey);
    // Strip the private fields → a public-only JWK, then re-import as a public key.
    const { d, p, q, dp, dq, qi, ...pub } = privJwk;
    void d;
    void p;
    void q;
    void dp;
    void dq;
    void qi;
    publicKey = await importJwkPublic(pub);
  }

  const publicJwk = await exportJWK(publicKey);
  const kid = env.JWT_KID ?? (await calculateJwkThumbprint(publicJwk));
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  return { privateKey, publicKey, publicJwk, kid };
}

/** Import a public JWK as a key (thin wrapper to keep the import list tidy). */
async function importJwkPublic(jwk: JWK): Promise<KeyLike> {
  const { importJWK } = await import('jose');
  return (await importJWK(jwk, 'RS256')) as KeyLike;
}

import type { AppEnv } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadRs256Keys, type Rs256Keys } from '../src/auth/jwt-keys.js';
import { TokenIssuerService } from '../src/auth/token-issuer.service.js';
import { TokenVerifierService } from '../src/auth/token-verifier.service.js';

const SECRET = 'issuer-verifier-secret';

/** Build an env stub with the JWT_* knobs the issuer/verifier read. */
function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ADMIN_JWT_SECRET: SECRET,
    JWT_SIGNING_ALG: 'HS256',
    JWT_ACCESS_TTL: '12h',
    JWT_VERIFY_LEGACY_HS256: true,
    ...overrides,
  } as unknown as AppEnv;
}

/** A generated RS256 keypair → the Rs256Keys the module loads from env. */
let rs256: Rs256Keys;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256');
  const pem = await exportPKCS8(privateKey);
  const keys = await loadRs256Keys(env({ JWT_PRIVATE_KEY: pem }));
  if (keys === null) throw new Error('loadRs256Keys returned null for a real private key');
  rs256 = keys;
});

function issuer(e: AppEnv, keys: Rs256Keys | null): TokenIssuerService {
  return new TokenIssuerService(e, new JwtService({ secret: SECRET }), keys);
}
function verifier(e: AppEnv, keys: Rs256Keys | null): TokenVerifierService {
  return new TokenVerifierService(e, new JwtService({ secret: SECRET }), keys);
}

describe('TokenIssuerService / TokenVerifierService — HS256 (default)', () => {
  it('signs + verifies an HS256 token by default (no RS256 keys)', async () => {
    const e = env();
    const token = await issuer(e, null).issueAccess({ sub: 'u1', role: 'user' });
    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    const claims = await verifier(e, null).verify(token);
    expect(claims?.sub).toBe('u1');
    expect(claims?.role).toBe('user');
  });

  it('rejects a forged HS256 token (wrong secret)', async () => {
    const forged = new JwtService({ secret: 'other' }).sign({ sub: 'x', role: 'user' });
    expect(await verifier(env(), null).verify(forged)).toBeUndefined();
  });

  it('rejects an expired HS256 token', async () => {
    const expired = new JwtService({ secret: SECRET }).sign(
      { sub: 'x', role: 'user' },
      { expiresIn: '-1s' },
    );
    expect(await verifier(env(), null).verify(expired)).toBeUndefined();
  });
});

describe('TokenIssuerService / TokenVerifierService — RS256 (opt-in)', () => {
  it('signs RS256 with a kid header and verifies it', async () => {
    const e = env({ JWT_SIGNING_ALG: 'RS256' });
    const token = await issuer(e, rs256).issueAccess({ sub: 'u2', role: 'admin' });
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe(rs256.kid);

    const claims = await verifier(e, rs256).verify(token);
    expect(claims?.sub).toBe('u2');
    expect(claims?.role).toBe('admin');
  });

  it('still verifies a legacy HS256 token under RS256 config when JWT_VERIFY_LEGACY_HS256=true', async () => {
    // A token minted the OLD way (HS256) must keep verifying after the RS256 flip.
    const legacy = new JwtService({ secret: SECRET }).sign({ sub: 'legacy', role: 'user' });
    const e = env({ JWT_SIGNING_ALG: 'RS256', JWT_VERIFY_LEGACY_HS256: true });
    const claims = await verifier(e, rs256).verify(legacy);
    expect(claims?.sub).toBe('legacy');
  });

  it('rejects a legacy HS256 token under RS256 config when JWT_VERIFY_LEGACY_HS256=false', async () => {
    const legacy = new JwtService({ secret: SECRET }).sign({ sub: 'legacy', role: 'user' });
    const e = env({ JWT_SIGNING_ALG: 'RS256', JWT_VERIFY_LEGACY_HS256: false });
    expect(await verifier(e, rs256).verify(legacy)).toBeUndefined();
  });

  it('rejects an RS256 token signed by a DIFFERENT key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const otherPem = await exportPKCS8(privateKey);
    const otherKeys = await loadRs256Keys(env({ JWT_PRIVATE_KEY: otherPem }));
    if (otherKeys === null) throw new Error('expected keys');
    const e = env({ JWT_SIGNING_ALG: 'RS256' });
    const forged = await issuer(e, otherKeys).issueAccess({ sub: 'forged', role: 'admin' });
    // Verified against the ORIGINAL public key → invalid. Legacy HS256 also fails.
    expect(await verifier(env({ JWT_SIGNING_ALG: 'RS256' }), rs256).verify(forged)).toBeUndefined();
  });
});

describe('loadRs256Keys', () => {
  it('returns null when no private key is configured (HS256 path)', async () => {
    expect(await loadRs256Keys(env())).toBeNull();
  });

  it('derives the public key from the private key and tags the JWK kid/use/alg', () => {
    expect(rs256.publicJwk.kid).toBe(rs256.kid);
    expect(rs256.publicJwk.use).toBe('sig');
    expect(rs256.publicJwk.alg).toBe('RS256');
    // The published JWK must NOT carry private fields.
    expect(rs256.publicJwk).not.toHaveProperty('d');
  });

  it('accepts a base64-encoded PEM', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const pem = await exportPKCS8(privateKey);
    const b64 = Buffer.from(pem, 'utf8').toString('base64');
    const keys = await loadRs256Keys(env({ JWT_PRIVATE_KEY: b64 }));
    expect(keys).not.toBeNull();
  });
});

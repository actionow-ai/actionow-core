import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtVerify } from 'jose';

import { ENV } from '../common/tokens.js';
import { type Rs256Keys } from './jwt-keys.js';
import { JWT_KEYS } from './jwt-keys.token.js';

/** A decoded, verified access-token claim bag. `sub` is always present. */
export type VerifiedClaims = Record<string, unknown> & { sub: string };

/**
 * The single, alg-aware ACCESS-token verifier shared by every operator/admin/member
 * guard. It tries RS256 first (against the configured/derived public key); on any
 * failure, if `JWT_VERIFY_LEGACY_HS256` is true (the default), it falls back to
 * HS256 against `ADMIN_JWT_SECRET`. Returns the decoded claims, or `undefined` on
 * ANY failure (bad signature, expired, malformed, wrong issuer) — guards translate
 * `undefined` into their uniform `unauthorized`. This centralizes the dual-accept
 * window so flipping to RS256 never invalidates a live HS256 session.
 *
 * NOTE: the guards still apply their OWN claim checks (`typ:'subject'` rejection
 * on operator guards, `typ:'subject'`+`tenant_id` requirement on the member
 * guard) on top of these decoded claims — this service only proves the signature.
 */
@Injectable()
export class TokenVerifierService {
  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly jwt: JwtService,
    @Inject(JWT_KEYS) private readonly rs256: Rs256Keys | null,
  ) {}

  /** Verify a token, returning its claims or `undefined` (fail closed). */
  async verify(token: string): Promise<VerifiedClaims | undefined> {
    // 1) RS256, when a public key is configured — verify the asymmetric signature.
    if (this.rs256 !== null) {
      const rs = await this.verifyRs256(token);
      if (rs !== undefined) return rs;
    }
    // 2) Legacy HS256 fallback. Always on when RS256 is NOT configured (the default
    //    deployment); under RS256 it is gated by JWT_VERIFY_LEGACY_HS256 (default
    //    true) so the migration window accepts both.
    const legacyAllowed = this.rs256 === null || (this.env.JWT_VERIFY_LEGACY_HS256 ?? true);
    if (legacyAllowed) {
      return this.verifyHs256(token);
    }
    return undefined;
  }

  /** Verify an RS256 token against the public key; `undefined` on any failure. */
  private async verifyRs256(token: string): Promise<VerifiedClaims | undefined> {
    const keys = this.rs256;
    if (keys === null) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys.publicKey, {
        ...(this.env.JWT_ISSUER !== undefined ? { issuer: this.env.JWT_ISSUER } : {}),
      });
      if (typeof payload.sub !== 'string') return undefined;
      return payload as VerifiedClaims;
    } catch {
      return undefined;
    }
  }

  /** Verify an HS256 token against `ADMIN_JWT_SECRET`; `undefined` on any failure. */
  private async verifyHs256(token: string): Promise<VerifiedClaims | undefined> {
    try {
      const claims = await this.jwt.verifyAsync<VerifiedClaims>(token, {
        secret: this.env.ADMIN_JWT_SECRET,
        ...(this.env.JWT_ISSUER !== undefined ? { issuer: this.env.JWT_ISSUER } : {}),
      });
      if (typeof claims.sub !== 'string') return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }
}

import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SignJWT } from 'jose';

import { ENV } from '../common/tokens.js';
import { type Rs256Keys } from './jwt-keys.js';
import { JWT_KEYS } from './jwt-keys.token.js';

/**
 * An access-token claim bag — at minimum a `sub`, plus any extra claims (`role`
 * for operator/admin, `tenant_id`+`typ` for a member) which pass straight through
 * to the signer. The open `Record` lets callers pass a plain claims literal.
 */
export type AccessClaims = Record<string, unknown> & { sub: string };

/**
 * The single, alg-aware ACCESS-token signer. When `JWT_SIGNING_ALG==='RS256'`
 * (opt-in) and an RS256 key is configured, it signs with the private key + a
 * `kid` header via jose. Otherwise it signs HS256 with `ADMIN_JWT_SECRET` (the
 * unchanged default). Every access-token mint site (user/admin/member) delegates
 * here so the signing alg is decided in exactly one place. Applies `JWT_ACCESS_TTL`
 * (default `12h`) and the optional `JWT_ISSUER`. Never logs key material.
 */
@Injectable()
export class TokenIssuerService {
  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly jwt: JwtService,
    @Inject(JWT_KEYS) private readonly rs256: Rs256Keys | null,
  ) {}

  /** The access-token TTL string (e.g. `12h`); the default is filled by env. */
  get accessTtl(): string {
    return this.env.JWT_ACCESS_TTL ?? '12h';
  }

  /** Sign an access token for the given claims, alg per `JWT_SIGNING_ALG`. */
  async issueAccess(claims: AccessClaims): Promise<string> {
    if (this.env.JWT_SIGNING_ALG === 'RS256' && this.rs256 !== null) {
      return this.signRs256(claims);
    }
    // HS256 (default) — keeps the exact current behavior (ADMIN_JWT_SECRET, 12h).
    // `expiresIn` is a TTL string (e.g. `12h`); @nestjs/jwt types it as a narrow
    // `StringValue` template — a plain `string` needs the cast.
    return this.jwt.signAsync(claims, {
      secret: this.env.ADMIN_JWT_SECRET,
      expiresIn: this.accessTtl as `${number}h`,
      ...(this.env.JWT_ISSUER !== undefined ? { issuer: this.env.JWT_ISSUER } : {}),
    });
  }

  /** Sign an RS256 access token with a `kid` header via jose. */
  private async signRs256(claims: AccessClaims): Promise<string> {
    const keys = this.rs256;
    if (keys === null) {
      // Should be unreachable (guarded by the caller), but fail closed loudly
      // rather than silently downgrading to HS256.
      throw new Error('RS256 signing requested but no private key is configured');
    }
    const builder = new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
      .setIssuedAt()
      .setExpirationTime(this.accessTtl);
    if (this.env.JWT_ISSUER !== undefined) builder.setIssuer(this.env.JWT_ISSUER);
    return builder.sign(keys.privateKey);
  }
}

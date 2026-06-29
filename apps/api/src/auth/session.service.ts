import { randomUUID } from 'node:crypto';

import type { Database, SessionPrincipalKind, SessionRow } from '@actionow/db';
import {
  createSession,
  findLiveSessionByHash,
  findSessionByHashAnyState,
  generateRefreshToken,
  hashRefreshToken,
  revokeFamily,
  revokeSession,
  rotateSession,
} from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineUnauthorized } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';
import { TokenIssuerService } from './token-issuer.service.js';

/** Best-effort request metadata captured on a session row. */
export interface SessionReqMeta {
  readonly userAgent?: string | null | undefined;
  readonly ip?: string | null | undefined;
}

/** Describes the principal a session is being minted for (drives claims + linkage). */
export interface SessionPrincipal {
  readonly principalKind: SessionPrincipalKind;
  /** For `user`/`admin`: the user id. For `subject`: the subject id. */
  readonly id: string;
  /** The role re-minted into a `user`/`admin` access token. */
  readonly role?: string | undefined;
  /** The tenant scope re-minted into a `subject` access token (required for subject). */
  readonly tenantId?: string | null | undefined;
}

/** The additive token-pair returned by login/register/refresh. `token === accessToken`. */
export interface TokenPair {
  /** Back-compat alias of `accessToken` — existing clients/tests/apps-web keep reading `token`. */
  token: string;
  accessToken: string;
  refreshToken: string;
  /** The access-token TTL (e.g. `12h`), echoed for clients. */
  expiresIn: string;
}

/** Parse a TTL string like `30d`/`12h`/`45m`/`90s` into milliseconds. */
function ttlMs(ttl: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(ttl.trim());
  if (m === null) {
    // Fall back to 30 days if a non-standard string slips through (refresh TTL only).
    return 30 * 24 * 60 * 60 * 1000;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const factor =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/**
 * Owns the refresh-token rotation lifecycle behind the platform login session.
 * On login a session row is created carrying the sha256 hash of a one-time
 * refresh plaintext. `refresh` rotates it (new refresh + re-minted access from the
 * session's own principal claims) and detects reuse/theft: a refresh whose hash
 * matches an already-REVOKED row revokes the WHOLE family and 401s. `logout`
 * revokes the presented session. The plaintext refresh token is never stored.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly issuer: TokenIssuerService,
  ) {}

  private get refreshTtl(): string {
    return this.env.JWT_REFRESH_TTL ?? '30d';
  }

  /** Mint a NEW session + return the additive token pair (login/register). */
  async createForPrincipal(
    principal: SessionPrincipal,
    accessToken: string,
    meta: SessionReqMeta = {},
  ): Promise<TokenPair> {
    const refreshPlain = generateRefreshToken();
    const expiresAt = new Date(Date.now() + ttlMs(this.refreshTtl));
    await createSession(this.db, {
      principalKind: principal.principalKind,
      // user + admin sessions both carry the user id in `user_id` (the linkage
      // CHECK is unconditional for 'admin', so this passes); a subject session
      // carries the subject id in `subject_id` instead.
      userId: principal.principalKind === 'subject' ? null : principal.id,
      subjectId: principal.principalKind === 'subject' ? principal.id : null,
      tenantId: principal.tenantId ?? null,
      refreshHash: hashRefreshToken(refreshPlain),
      familyId: randomUUID(),
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      token: accessToken,
      accessToken,
      refreshToken: refreshPlain,
      expiresIn: this.issuer.accessTtl,
    };
  }

  /**
   * Rotate a refresh token: validate it is LIVE, re-mint the access token from the
   * session's stored principal, rotate to a fresh refresh in the same family, and
   * return the new pair. A refresh whose hash matches an already-REVOKED row is a
   * replay (theft) → revoke the whole family + 401. Anything unknown/expired → 401.
   */
  async refresh(refreshToken: string, meta: SessionReqMeta = {}): Promise<TokenPair> {
    const hash = hashRefreshToken(refreshToken);
    const live = await findLiveSessionByHash(this.db, hash);
    if (live === undefined) {
      // Reuse detection: a hash that exists but is revoked means the token was
      // already rotated — i.e. replayed/stolen. Revoke the entire lineage.
      const stale = await findSessionByHashAnyState(this.db, hash);
      if (stale !== undefined) {
        await revokeFamily(this.db, stale.familyId);
      }
      throw engineUnauthorized('invalid or expired refresh token');
    }

    const accessToken = await this.issuer.issueAccess(claimsForSession(live));
    const nextPlain = generateRefreshToken();
    const expiresAt = new Date(Date.now() + ttlMs(this.refreshTtl));
    await rotateSession(this.db, live, {
      refreshHash: hashRefreshToken(nextPlain),
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      token: accessToken,
      accessToken,
      refreshToken: nextPlain,
      expiresIn: this.issuer.accessTtl,
    };
  }

  /**
   * Revoke the session behind a refresh token (logout). Idempotent and uniform: a
   * present-but-already-revoked or unknown token is a silent no-op (no 401 — logout
   * of a dead token still leaves you logged out).
   */
  async logout(refreshToken: string): Promise<void> {
    const live = await findLiveSessionByHash(this.db, hashRefreshToken(refreshToken));
    if (live !== undefined) {
      await revokeSession(this.db, live.id);
    }
  }
}

/** Re-derive the access-token claims to re-mint from a stored session row. */
export function claimsForSession(s: SessionRow): Record<string, unknown> & { sub: string } {
  if (s.principalKind === 'subject') {
    // A member token: `{sub, tenant_id, typ:'subject'}` — the member-guard contract.
    return { sub: s.subjectId ?? '', tenant_id: s.tenantId ?? '', typ: 'subject' };
  }
  // user/admin token: `{sub, role}`. The role is NOT stored on the session; the
  // session principal_kind ('admin' vs 'user') determines the minted role so the
  // re-issued token gates the same plane as the original login.
  const role = s.principalKind === 'admin' ? 'admin' : 'user';
  return { sub: s.userId ?? '', role };
}

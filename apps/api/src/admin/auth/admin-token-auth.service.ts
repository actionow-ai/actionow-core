import type { AdminTokenRecord, Database } from '@actionow/db';
import { findAdminTokenByHash, hashAdminToken } from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import { DB } from '../../common/tokens.js';
import type { AdminContext } from './admin.guard.js';

/** The `at_` prefix that marks a Bearer credential as an admin service token. */
export const ADMIN_TOKEN_PREFIX = 'at_';

/**
 * The db surface admin-token auth depends on. Extracted to an interface so unit
 * tests inject a fake repo with a fixed record instead of a live database.
 */
export interface AdminTokenAuthRepo {
  findAdminTokenByHash(db: Database, hash: string): Promise<AdminTokenRecord | undefined>;
}

/** Production repo wired to the real `@actionow/db` function. */
export const defaultAdminTokenAuthRepo: AdminTokenAuthRepo = { findAdminTokenByHash };

/** DI token for the (overridable) {@link AdminTokenAuthRepo}. */
export const ADMIN_TOKEN_AUTH_REPO = Symbol('ADMIN_TOKEN_AUTH_REPO');

/**
 * Authenticates an `at_`-prefixed admin SERVICE TOKEN (M2M credential), the
 * machine equivalent of a human admin login. Hashes the presented plaintext and
 * looks the LIVE row up (revoked/soft-deleted tokens read as absent), then
 * rejects anything not `active` or past its `expires_at`. On success it yields an
 * {@link AdminContext} attributed to the admin who minted the token (`created_by`)
 * with the full-admin `role`. Returns `undefined` on ANY failure so the guard can
 * answer with the same uniform `unauthorized` it gives a bad JWT (no enumeration).
 *
 * The plaintext is never logged and never compared directly — only its sha256 hash
 * touches the db.
 */
@Injectable()
export class AdminTokenAuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADMIN_TOKEN_AUTH_REPO) private readonly repo: AdminTokenAuthRepo,
  ) {}

  async verify(plaintext: string): Promise<AdminContext | undefined> {
    const record = await this.repo.findAdminTokenByHash(this.db, hashAdminToken(plaintext));
    if (record === undefined) return undefined;
    if (record.status !== 'active') return undefined;
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) return undefined;
    return { adminId: record.createdBy, role: 'admin' };
  }
}

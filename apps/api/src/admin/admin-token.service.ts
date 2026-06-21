import type {
  AdminTokenView,
  CreatedAdminToken,
  Database,
  KeysetResult,
  PageParams,
} from '@actionow/db';
import { createAdminToken, listAdminTokens, softDeleteAdminToken } from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import { engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import type { CreateAdminTokenDto } from './dto/admin.dto.js';

/**
 * Mints, lists, and revokes admin SERVICE TOKENS (M2M credentials). The read side
 * never exposes the token hash; the write side returns the one-time plaintext.
 * Verification of a presented token lives in `AdminTokenAuthService` (the guard's
 * collaborator) — this service is the operator-facing CRUD.
 */
@Injectable()
export class AdminTokenService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Mint a service token attributed to `createdBy` (the authenticated admin's
   * user id). `expiresAt` (an ISO string from the validated body) becomes a Date,
   * or `undefined` → the token never expires.
   */
  mint(dto: CreateAdminTokenDto, createdBy: string): Promise<CreatedAdminToken> {
    return createAdminToken(this.db, {
      name: dto.name,
      createdBy,
      expiresAt: dto.expiresAt === undefined ? undefined : new Date(dto.expiresAt),
    });
  }

  /** List live service tokens (metadata only, no hash), keyset-paginated. */
  list(page: PageParams): Promise<KeysetResult<AdminTokenView>> {
    return listAdminTokens(this.db, page);
  }

  /**
   * Revoke (soft-delete) a token by id. The guard treats a soft-deleted token as
   * absent, so it is rejected with 401 afterward. Throws `resource_not_found`
   * (404) when the id matches no live token (already revoked / unknown).
   */
  async revoke(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteAdminToken(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`admin token ${id} not found`);
    }
    return { id: deleted };
  }
}

import type { Database } from '@actionow/db';
import { getAccountByTenant } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { engineUnauthorized } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';

/** The resolved caller identity for a request: tenant + its billing account. */
export interface TenantContext {
  tenantId: string;
  accountId: string;
}

/**
 * STUB auth (Phase 3 placeholder — real API-key auth lands in Phase 5).
 *
 * The tenant is taken from the `x-tenant-id` request header, falling back to
 * the `DEV_TENANT_ID` env var when the header is absent. The account is the
 * tenant's single account (Phase 3 assumes one account per tenant). No API key
 * is verified, no rate limit is applied, and no resource allowlist is checked
 * — all of that is Phase 5.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async resolve(req: Request): Promise<TenantContext> {
    const headerValue = req.headers['x-tenant-id'];
    const headerTenant = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const tenantId = headerTenant ?? this.env.DEV_TENANT_ID;
    if (tenantId === undefined || tenantId === '') {
      throw engineUnauthorized('missing tenant: set x-tenant-id or DEV_TENANT_ID');
    }

    const account = await getAccountByTenant(this.db, tenantId);
    if (account === undefined) {
      throw engineUnauthorized(`no account for tenant ${tenantId}`);
    }
    return { tenantId, accountId: account.id };
  }
}

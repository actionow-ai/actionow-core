import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { engineUnauthorized } from '../common/errors.js';
import type { AuthedRequest } from './api-key.guard.js';

/** The resolved caller identity for a request: tenant + its billing account. */
export interface TenantContext {
  tenantId: string;
  accountId: string;
  /** The api_key that authenticated this request; absent on the dev fallback. */
  apiKeyId?: string;
}

/**
 * Reads the tenant context the {@link ApiKeyGuard} attaches to the request
 * (`req.auth`). The guard performs the actual authentication (API-key hash
 * lookup, allowlist, account resolution); this service just projects the
 * guard's {@link ApiKeyContext} into the narrower {@link TenantContext} the
 * run/jobs services consume.
 *
 * If `req.auth` is absent the route was reached without the guard — a wiring
 * bug — so we fail closed with `unauthorized` rather than guessing a tenant.
 */
@Injectable()
export class AuthService {
  resolve(req: Request): TenantContext {
    const auth = (req as AuthedRequest).auth;
    if (auth === undefined) {
      throw engineUnauthorized('request is not authenticated');
    }
    const ctx: TenantContext = { tenantId: auth.tenantId, accountId: auth.accountId };
    // `apiKeyId` is null on the `x-tenant-id` dev fallback (no key presented);
    // omit it then so the optional field stays absent (exactOptionalPropertyTypes).
    if (auth.apiKeyId !== null) ctx.apiKeyId = auth.apiKeyId;
    return ctx;
  }
}

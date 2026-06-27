import type { ApiKeyRecord, Database } from '@actionow/db';
import { findApiKeyByHash, getAccountByTenant, hashApiKey } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';

import { engineUnauthorized } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * The authenticated caller context the {@link ApiKeyGuard} attaches to the
 * request as `req.auth`. Downstream services (run/jobs) read this instead of the
 * Phase-3 `x-tenant-id` stub.
 */
export interface ApiKeyContext {
  readonly tenantId: string;
  readonly accountId: string;
  /** Null on the `x-tenant-id` dev fallback (no key was presented). */
  readonly apiKeyId: string | null;
  /** Resources this key may run; empty means "no restriction". */
  readonly resourceAllowlist: string[];
  /** Per-(tenant,resource) requests-per-minute cap, or `null` for the default. */
  readonly rateLimit: number | null;
  /**
   * The route group (分组; Track 3/4) this key is bound to; `null` → resolve to
   * the well-known `default` group at routing time. Scopes which channels of a
   * resource the key may route to (Track 4) and, later, the customer price
   * ratio (Track 5).
   */
  readonly routeGroupId: string | null;
  /** The key's bound limit plan (额度套餐); `null` → no per-key limits. */
  readonly limitPlanId: string | null;
  /** The tenant's bound limit plan (on its account); `null` → no tenant limits. */
  readonly tenantLimitPlanId: string | null;
  /**
   * The subject (end-user) this key is scoped to (unified tenancy G-B); `null` →
   * a tenant-level key (today's behavior). When set, the data plane attributes
   * spend/usage to this subject and read endpoints scope to it (§4b).
   */
  readonly subjectId: string | null;
  /** The subject's bound limit plan (额度套餐); `null` → none / tenant-level key. */
  readonly subjectLimitPlanId: string | null;
}

/** An express request carrying the guard-populated {@link ApiKeyContext}. */
export interface AuthedRequest extends Request {
  auth?: ApiKeyContext;
}

/**
 * The db surface the guard depends on. Extracted to an interface so unit tests
 * inject a fake repo with a fixed key/account instead of a live database.
 */
export interface ApiKeyRepo {
  findApiKeyByHash(db: Database, hash: string): Promise<ApiKeyRecord | undefined>;
  getAccountByTenant(
    db: Database,
    tenantId: string,
  ): Promise<{ id: string; limitPlanId: string | null } | undefined>;
}

/** Production repo wired to the real `@actionow/db` functions. */
export const defaultApiKeyRepo: ApiKeyRepo = { findApiKeyByHash, getAccountByTenant };

/** DI token for the (overridable) {@link ApiKeyRepo}. */
export const API_KEY_REPO = Symbol('API_KEY_REPO');

/**
 * Authenticates `/v1/*` requests by API key (§8).
 *
 * Reads the key from `Authorization: Bearer ak_...` (or the `x-api-key` header),
 * hashes it with sha256, and looks the hash up via {@link ApiKeyRepo}. A missing,
 * unknown, or non-`active` key → 401 `unauthorized`. On success it resolves the
 * tenant's account and attaches an {@link ApiKeyContext} to `req.auth`, then
 * enforces the key's `resourceAllowlist` against the `:resourceId` route param.
 *
 * The plaintext key is never logged. The only non-key path is a `x-tenant-id`
 * dev fallback, gated to `NODE_ENV !== 'production'` AND an explicit
 * `ALLOW_DEV_TENANT_HEADER` opt-in, so production always requires a real key and
 * a misconfigured non-prod instance does not silently accept an unauthenticated
 * tenant header.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_KEY_REPO) private readonly repo: ApiKeyRepo,
    @Inject(ENV) private readonly env: AppEnv,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const presented = extractKey(req);

    if (presented === undefined) {
      const ctx = await this.resolveDevFallback(req);
      req.auth = ctx;
      return true;
    }

    const record = await this.repo.findApiKeyByHash(this.db, hashApiKey(presented));
    if (record?.status !== 'active') {
      // Covers a missing key (undefined) and a disabled one. Don't echo the key
      // (or any part of it) — just reject.
      throw engineUnauthorized('invalid or disabled API key');
    }

    // A subject-scoped key whose subject is disabled/soft-deleted authenticates
    // as unusable (unified tenancy G-B): the end-user's access is revoked even if
    // the raw key string is still valid.
    if (record.subjectId !== null && record.subjectActive !== true) {
      throw engineUnauthorized('the api key’s end-user is disabled');
    }

    this.enforceAllowlist(record.resourceAllowlist, resourceParam(req));

    const account = await this.repo.getAccountByTenant(this.db, record.tenantId);
    if (account === undefined) {
      throw engineUnauthorized(`no account for tenant ${record.tenantId}`);
    }

    req.auth = {
      tenantId: record.tenantId,
      accountId: account.id,
      apiKeyId: record.id,
      resourceAllowlist: record.resourceAllowlist,
      rateLimit: record.rateLimit,
      routeGroupId: record.routeGroupId,
      limitPlanId: record.limitPlanId,
      tenantLimitPlanId: account.limitPlanId,
      subjectId: record.subjectId,
      subjectLimitPlanId: record.subjectLimitPlanId,
    };
    return true;
  }

  /**
   * Dev-only fallback: resolve the tenant from `x-tenant-id` when no key is
   * presented. Disabled in production, and otherwise requires the explicit
   * `ALLOW_DEV_TENANT_HEADER` opt-in, so a real API key is required by default.
   */
  private async resolveDevFallback(req: AuthedRequest): Promise<ApiKeyContext> {
    const allowDevHeader =
      (await this.settings?.get('ALLOW_DEV_TENANT_HEADER')) ?? this.env.ALLOW_DEV_TENANT_HEADER;
    if (this.env.NODE_ENV === 'production' || !allowDevHeader) {
      throw engineUnauthorized('missing API key');
    }
    const header = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(header) ? header[0] : header;
    if (tenantId === undefined || tenantId === '') {
      throw engineUnauthorized('missing API key');
    }
    const account = await this.repo.getAccountByTenant(this.db, tenantId);
    if (account === undefined) {
      throw engineUnauthorized(`no account for tenant ${tenantId}`);
    }
    return {
      tenantId,
      accountId: account.id,
      apiKeyId: null,
      resourceAllowlist: [],
      rateLimit: null,
      // No key was presented → no bound group; routing resolves the `default`
      // group (or falls back to all channels) for the dev tenant.
      routeGroupId: null,
      limitPlanId: null,
      tenantLimitPlanId: account.limitPlanId,
      subjectId: null,
      subjectLimitPlanId: null,
    };
  }

  /** A non-empty allowlist that excludes the requested resource → 401. */
  private enforceAllowlist(allowlist: string[], resourceId: string | undefined): void {
    if (allowlist.length === 0 || resourceId === undefined) return;
    if (!allowlist.includes(resourceId)) {
      throw engineUnauthorized(`API key not allowed for resource ${resourceId}`);
    }
  }
}

/** Read the presented API key from the `Authorization` or `x-api-key` header. */
function extractKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (match?.[1] !== undefined) return match[1];
  }
  const apiKeyHeader = req.headers['x-api-key'];
  const value = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/** The `:resourceId` route param when the request targets a specific resource. */
function resourceParam(req: Request): string | undefined {
  const params = req.params as Record<string, string | undefined>;
  return params.resourceId;
}

import {
  type ApiKeyRow,
  createApiKey,
  type CreatedApiKey,
  type Database,
  getLimitPlanById,
  getSubAccount,
  getSubjectById,
  type KeysetResult,
  type LimitRuleStatus,
  limitRuleStatus,
  listApiKeysBySubject,
  listUsageLogsBySubject,
  type PageParams,
  softDeleteApiKeyForSubject,
  type SubAccountRow,
  type SubjectRow,
  updateSubject,
  type UsageLogRow,
} from '@actionow/db';
import { hashPassword, verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import type { MemberChangePasswordDto, MemberCreateApiKeyDto } from './dto/member.dto.js';

/** The caller-subject's wallet, mode-tagged: `hard` (own sub-wallet) | `shared` (tenant pool). */
export interface MemberBalance {
  readonly mode: 'shared' | 'hard';
  readonly balance: bigint;
  readonly held: bigint;
}

/** The caller-subject's governance status: effective plan (or null) + rules-with-usage. */
export interface MemberLimits {
  readonly plan: { id: string; name: string } | null;
  readonly rules: LimitRuleStatus[];
}

/**
 * The data layer behind the {@link MemberController} (`/member/*`, Part B). Every
 * method is locked to the SUBJECT the {@link MemberGuard} resolved from the member
 * token — the `subjectId`/`tenantId` are NEVER read from a request body/path, so
 * an end-user can only ever read OR mutate its own data. A subject is also tenant-
 * scoped via its stored `tenantId`, so a stale token whose subject was reassigned
 * still can't cross the tenant boundary. Mirrors the tenant-scoped
 * {@link ConsoleService}, narrowed one level down to a single subject. The write
 * methods (profile, password, self-mint/revoke own keys) reuse the same tenant-
 * AND-subject-predicated repos so a member can never touch a sibling subject's row.
 */
@Injectable()
export class MemberService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Load the caller-subject (the guard already verified it is active); 404 only on
   * the (post-guard impossible) absent row. Used by the routes that need the
   * subject's tenant scope (`getSubjectById` is tenant-scoped via its own row).
   */
  private async requireSubject(subjectId: string, tenantId: string): Promise<SubjectRow> {
    const subject = await getSubjectById(this.db, tenantId, subjectId);
    if (subject === undefined) throw engineNotFound(`subject ${subjectId} not found`);
    return subject;
  }

  /** The caller-subject's own identity (`GET /member/me`). */
  me(subjectId: string, tenantId: string): Promise<SubjectRow> {
    return this.requireSubject(subjectId, tenantId);
  }

  /** The caller-subject's own per-call usage log, keyset newest-first (`GET /member/usage`). */
  usage(subjectId: string, tenantId: string, page: PageParams): Promise<KeysetResult<UsageLogRow>> {
    return listUsageLogsBySubject(this.db, tenantId, subjectId, page);
  }

  /**
   * The caller-subject's wallet (`GET /member/balance`): its HARD sub-wallet
   * (`mode:'hard'`) when one is open, else `mode:'shared'` (the subject draws from
   * the tenant pool → balance/held reported as 0). Scoped to `(tenant, subject)`.
   */
  async balance(subjectId: string, tenantId: string): Promise<MemberBalance> {
    const sub: SubAccountRow | undefined = await getSubAccount(this.db, tenantId, subjectId);
    if (sub === undefined) return { mode: 'shared', balance: 0n, held: 0n };
    return { mode: 'hard', balance: sub.creditBalance, held: sub.creditHeld };
  }

  /** The caller-subject's own api keys (masked; the hash is never selected). */
  keys(subjectId: string, tenantId: string): Promise<Omit<ApiKeyRow, 'hash'>[]> {
    return listApiKeysBySubject(this.db, tenantId, subjectId);
  }

  /**
   * The caller-subject's governance status (`GET /member/limits`): its bound limit
   * plan (the subject row's `limitPlanId`) and each effective rule paired with the
   * subject's current usage. `plan` is null when no plan is bound (→ "unlimited").
   * Reuses {@link limitRuleStatus} with the `'subject'` scope, exactly as the
   * operator/console surfaces do.
   */
  async limits(subjectId: string, tenantId: string): Promise<MemberLimits> {
    const subject = await this.requireSubject(subjectId, tenantId);
    const planId = subject.limitPlanId;
    const [planRow, rules] = await Promise.all([
      planId !== null ? getLimitPlanById(this.db, planId) : Promise.resolve(undefined),
      limitRuleStatus(this.db, 'subject', subjectId, planId),
    ]);
    return {
      plan: planRow ? { id: planRow.id, name: planRow.name } : null,
      rules,
    };
  }

  // ----- writes (self-service; subject+tenant scoped) -----

  /**
   * Update the caller-subject's own profile (`PATCH /member/me`). Only
   * `displayName` is mutable here. The update repo is tenant-AND-id predicated;
   * the id is the guard's `subjectId`, so a member only ever patches its own row.
   * Returns the refreshed row (404 only on the post-guard-impossible absent row).
   */
  async updateProfile(
    subjectId: string,
    tenantId: string,
    dto: { displayName: string | null },
  ): Promise<SubjectRow> {
    const updated = await updateSubject(this.db, tenantId, subjectId, {
      displayName: dto.displayName,
    });
    if (updated === undefined) throw engineNotFound(`subject ${subjectId} not found`);
    return updated;
  }

  /**
   * Change the caller-subject's own password (`POST /member/me/password`): verify
   * `current_password` against the stored scrypt hash, then swap in a hash of the
   * new one. A passwordless (Model-B) subject — one with no `password_hash` — or a
   * wrong current password is `invalid_input` (the two are indistinguishable to
   * the caller by design). The write is tenant+id scoped to the guard's subject.
   */
  async changePassword(
    subjectId: string,
    tenantId: string,
    dto: MemberChangePasswordDto,
  ): Promise<void> {
    const subject = await this.requireSubject(subjectId, tenantId);
    if (
      subject.passwordHash === null ||
      !verifyPassword(subject.passwordHash, dto.current_password)
    ) {
      throw engineInvalidInput('current password is incorrect');
    }
    await updateSubject(this.db, tenantId, subjectId, {
      passwordHash: hashPassword(dto.new_password),
    });
  }

  /**
   * Self-mint a SUBJECT-SCOPED data-plane key (`POST /member/api-keys`); the
   * plaintext is returned ONCE. The `subjectId`/`tenantId` come from the guard —
   * NEVER the body — so the key is always bound to the caller's own subject.
   */
  createApiKey(
    subjectId: string,
    tenantId: string,
    dto: MemberCreateApiKeyDto,
  ): Promise<CreatedApiKey> {
    return createApiKey(this.db, {
      tenantId,
      subjectId,
      resourceAllowlist: dto.resourceAllowlist,
    });
  }

  /**
   * Revoke one of the caller-subject's OWN keys (`DELETE /member/api-keys/:id`).
   * The repo predicate is `(id, tenant_id, subject_id)`, so a sibling subject's
   * key, a tenant-level key, or a cross-tenant id matches no row → 404 (never a
   * successful revoke). Idempotent: a second revoke is also 404.
   */
  async revokeApiKey(subjectId: string, tenantId: string, keyId: string): Promise<void> {
    const revoked = await softDeleteApiKeyForSubject(this.db, keyId, tenantId, subjectId);
    if (revoked === undefined) throw engineNotFound(`api key ${keyId} not found`);
  }
}

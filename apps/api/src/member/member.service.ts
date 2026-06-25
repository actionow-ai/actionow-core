import {
  type ApiKeyRow,
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
  type SubAccountRow,
  type SubjectRow,
  type UsageLogRow,
} from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import { engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';

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
 * The READ-ONLY data layer behind the {@link MemberController} (`/member/*`, Part
 * B). Every method is locked to the SUBJECT the {@link MemberGuard} resolved from
 * the member token — the `subjectId` is NEVER read from a request body/path, so an
 * end-user can only ever read its own data. A subject is also tenant-scoped via
 * its stored `tenantId`, so a stale token whose subject was reassigned still can't
 * cross the tenant boundary. Mirrors the tenant-scoped {@link ConsoleService}
 * readers, narrowed one level down to a single subject.
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
}

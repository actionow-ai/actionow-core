import type { Database, SubjectRow } from '@actionow/db';
import { getSubjectById } from '@actionow/db';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { TokenVerifierService } from '../auth/token-verifier.service.js';
import { engineUnauthorized } from '../common/errors.js';
import { DB } from '../common/tokens.js';

/** The authenticated end-user (member) context the guard attaches as `req.member`. */
export interface MemberContext {
  readonly subjectId: string;
  readonly tenantId: string;
}

/** An express request carrying the guard-populated {@link MemberContext}. */
export interface MemberRequest extends Request {
  member?: MemberContext;
}

/**
 * The db surface {@link MemberGuard} depends on. Extracted to an interface so
 * unit tests inject a fake repo instead of a live database. Mirrors the
 * `@actionow/db` function signature.
 */
export interface MemberRepo {
  getSubjectById(db: Database, tenantId: string, id: string): Promise<SubjectRow | undefined>;
}

/** Production repo wired to the real `@actionow/db` function. */
export const defaultMemberRepo: MemberRepo = { getSubjectById };

/** DI token for the (overridable) {@link MemberRepo}. */
export const MEMBER_REPO = Symbol('MEMBER_REPO');

/**
 * Authenticates the end-user self-service plane (`/member`, Part B) via the
 * MEMBER JWT — the `{sub, tenant_id, typ:'subject'}` claims signed against
 * `ADMIN_JWT_SECRET` by `LocalAuthService.issueMemberToken`. The inverse of
 * {@link ConsoleGuard}: it accepts ONLY member tokens and rejects an
 * operator/admin token (which carries no `typ:'subject'`). Verifies the Bearer
 * token, loads the subject *scoped to the token's `tenant_id`* (so a forged or
 * cross-tenant `tenant_id` resolves to nothing — isolation invariant: a member
 * only ever reads its own token subject), and requires an `active` subject. On
 * success it attaches `{subjectId, tenantId}` to `req.member`. Any
 * missing/expired/forged token, a non-subject token, or a non-active/absent
 * subject fails closed with `unauthorized`.
 */
@Injectable()
export class MemberGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifierService,
    @Inject(DB) private readonly db: Database,
    @Inject(MEMBER_REPO) private readonly repo: MemberRepo,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MemberRequest>();
    const token = bearerToken(req);
    if (token === undefined) {
      throw engineUnauthorized('missing member token');
    }

    // The shared alg-aware verifier (RS256 first, then legacy HS256). `undefined`
    // covers expiry/bad signature/malformed — fail closed.
    const verified = await this.verifier.verify(token);
    if (verified === undefined) {
      throw engineUnauthorized('invalid or expired member token');
    }
    const claims = verified as { sub: string; tenant_id?: string; typ?: string };

    // Only a MEMBER token (`typ:'subject'`, with a tenant scope) reaches Part B.
    // An operator/admin token (no `typ:'subject'`) is rejected here, mirroring
    // the inverse rejection of member tokens by the operator console guard.
    if (claims.typ !== 'subject' || typeof claims.tenant_id !== 'string') {
      throw engineUnauthorized('not a member token');
    }

    // Tenant-scoped lookup: the subject must live in the token's tenant. A
    // cross-tenant or forged `tenant_id` resolves to undefined and fails closed —
    // a member is only ever its own subject.
    const subject = await this.repo.getSubjectById(this.db, claims.tenant_id, claims.sub);
    if (subject?.status !== 'active') {
      throw engineUnauthorized('member subject not active');
    }

    req.member = { subjectId: subject.id, tenantId: subject.tenantId };
    return true;
  }
}

/** Read a Bearer token from the `Authorization` header. */
function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1];
}

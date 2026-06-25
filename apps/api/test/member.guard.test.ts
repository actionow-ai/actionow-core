import type { SubjectRow } from '@actionow/db';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { MemberGuard, type MemberRepo } from '../src/member/member.guard.js';

const SECRET = 'member-test-secret';
const jwt = new JwtService({ secret: SECRET });

function ctxFor(req: Partial<Request>): ExecutionContext {
  const request = { headers: {}, ...req } as Request;
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function repoWith(subj: Partial<SubjectRow> | undefined): MemberRepo {
  const full: SubjectRow | undefined =
    subj === undefined
      ? undefined
      : {
          id: 's1',
          tenantId: 'tenant-1',
          externalId: null,
          email: 's@x.com',
          passwordHash: null,
          displayName: null,
          limitPlanId: null,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          ...subj,
        };
  // `getSubjectById(db, tenantId, id)` is tenant-scoped: only return the subject
  // when the queried tenant matches (a cross-tenant lookup resolves undefined).
  return {
    getSubjectById: (_db, tenantId, id) =>
      Promise.resolve(full?.tenantId === tenantId && full.id === id ? full : undefined),
  };
}

function guard(repo: MemberRepo): MemberGuard {
  return new MemberGuard(jwt, {} as never, repo, { ADMIN_JWT_SECRET: SECRET } as never);
}

async function memberToken(sub: string, tenantId: string): Promise<string> {
  return jwt.signAsync(
    { sub, tenant_id: tenantId, typ: 'subject' },
    { secret: SECRET, expiresIn: '5m' },
  );
}

describe('MemberGuard', () => {
  it('rejects a missing token (401)', async () => {
    await expect(guard(repoWith({})).canActivate(ctxFor({ headers: {} }))).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects an invalid/expired token (401)', async () => {
    const bad = await new JwtService({ secret: 'other' }).signAsync({
      sub: 's1',
      tenant_id: 'tenant-1',
      typ: 'subject',
    });
    await expect(
      guard(repoWith({})).canActivate(ctxFor({ headers: { authorization: `Bearer ${bad}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects an operator token (no typ:subject) (401)', async () => {
    const operator = await jwt.signAsync({ sub: 's1', role: 'user' }, { secret: SECRET });
    await expect(
      guard(repoWith({})).canActivate(ctxFor({ headers: { authorization: `Bearer ${operator}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects a token without tenant_id (401)', async () => {
    const noTenant = await jwt.signAsync({ sub: 's1', typ: 'subject' }, { secret: SECRET });
    await expect(
      guard(repoWith({})).canActivate(ctxFor({ headers: { authorization: `Bearer ${noTenant}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects a missing subject (401)', async () => {
    const t = await memberToken('s1', 'tenant-1');
    await expect(
      guard(repoWith(undefined)).canActivate(ctxFor({ headers: { authorization: `Bearer ${t}` } })),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects a disabled subject (401)', async () => {
    const t = await memberToken('s1', 'tenant-1');
    await expect(
      guard(repoWith({ status: 'disabled' })).canActivate(
        ctxFor({ headers: { authorization: `Bearer ${t}` } }),
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('rejects when the token tenant_id does not own the subject (cross-tenant) (401)', async () => {
    // Subject lives in tenant-1, but the token claims tenant-2 — the tenant-scoped
    // lookup must miss, never leaking a subject from another tenant.
    const t = await memberToken('s1', 'tenant-2');
    await expect(
      guard(repoWith({ tenantId: 'tenant-1' })).canActivate(
        ctxFor({ headers: { authorization: `Bearer ${t}` } }),
      ),
    ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
  });

  it('attaches {subjectId, tenantId} on success', async () => {
    const t = await memberToken('s1', 'tenant-1');
    const req = { headers: { authorization: `Bearer ${t}` } } as unknown as Request;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard(repoWith({})).canActivate(ctx)).resolves.toBe(true);
    const attached = (req as unknown as { member: Record<string, unknown> }).member;
    expect(attached).toMatchObject({ subjectId: 's1', tenantId: 'tenant-1' });
  });
});

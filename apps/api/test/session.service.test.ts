import type { SessionRow } from '@actionow/db';
import { describe, expect, it } from 'vitest';

import { claimsForSession } from '../src/auth/session.service.js';

/** A minimal live-ish session row; override only the fields under test. */
function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    principalKind: 'user',
    userId: 'u1',
    subjectId: null,
    tenantId: null,
    refreshHash: 'hash',
    familyId: 'fam',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
    replacedBy: null,
    userAgent: null,
    ip: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * `claimsForSession` is the refresh re-mint: it MUST derive the access role from
 * the session's `principal_kind` (the role is never stored on the session). The
 * regression these guard: an admin session must NOT re-mint role:'user'.
 */
describe('claimsForSession (refresh re-mint) reads principal_kind', () => {
  it('re-mints role:admin from an admin session (no silent downgrade)', () => {
    const claims = claimsForSession(sessionRow({ principalKind: 'admin', userId: 'admin-1' }));
    expect(claims).toEqual({ sub: 'admin-1', role: 'admin' });
  });

  it('re-mints role:user from a user (tenant-operator) session', () => {
    const claims = claimsForSession(sessionRow({ principalKind: 'user', userId: 'op-1' }));
    expect(claims).toEqual({ sub: 'op-1', role: 'user' });
  });

  it('re-mints typ:subject + tenant_id from a subject (member) session', () => {
    const claims = claimsForSession(
      sessionRow({
        principalKind: 'subject',
        userId: null,
        subjectId: 'sub-1',
        tenantId: 't-1',
      }),
    );
    expect(claims).toEqual({ sub: 'sub-1', tenant_id: 't-1', typ: 'subject' });
  });
});

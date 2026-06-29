import type { Database, UserRecord } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import type { AdminAuthRepo } from '../src/admin/auth/admin-auth.service.js';
import { AdminAuthService } from '../src/admin/auth/admin-auth.service.js';
import type { SessionPrincipal, SessionService, TokenPair } from '../src/auth/session.service.js';
import { TokenIssuerService } from '../src/auth/token-issuer.service.js';

const SECRET = 'test-admin-secret';

function makeRepo(found: UserRecord | undefined): AdminAuthRepo {
  return {
    findUserByEmail: (_db: Database, email: string): Promise<UserRecord | undefined> =>
      Promise.resolve(found?.email === email ? found : undefined),
  };
}

function service(repo: AdminAuthRepo): AdminAuthService {
  const issuer = new TokenIssuerService(
    { ADMIN_JWT_SECRET: SECRET, JWT_SIGNING_ALG: 'HS256', JWT_ACCESS_TTL: '12h' } as never,
    new JwtService({ secret: SECRET }),
    null,
  );
  // A stub SessionService that wraps the access token without touching the db.
  const sessions = {
    createForPrincipal: (_p: SessionPrincipal, accessToken: string): Promise<TokenPair> =>
      Promise.resolve({ token: accessToken, accessToken, refreshToken: 'rt_x', expiresIn: '12h' }),
  } as unknown as SessionService;
  return new AdminAuthService({} as Database, repo, issuer, sessions);
}

const admin: UserRecord = {
  id: 'admin-1',
  email: 'admin@actionow.local',
  emailVerified: true,
  passwordHash: hashPassword('hunter2'),
  role: 'admin',
  tenantRole: null,
  status: 'active',
  tenantId: null,
  createdAt: new Date(),
};

describe('AdminAuthService.login', () => {
  it('returns a JWT carrying sub + role for valid admin credentials', async () => {
    const svc = service(makeRepo(admin));
    const { token } = await svc.login('admin@actionow.local', 'hunter2');

    const claims = new JwtService({ secret: SECRET }).verify<{ sub: string; role: string }>(token);
    expect(claims.sub).toBe('admin-1');
    expect(claims.role).toBe('admin');
  });

  it('rejects a wrong password with unauthorized', async () => {
    const svc = service(makeRepo(admin));
    await expect(svc.login('admin@actionow.local', 'wrong')).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects an unknown email with unauthorized', async () => {
    const svc = service(makeRepo(admin));
    await expect(svc.login('nobody@actionow.local', 'hunter2')).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects a disabled admin', async () => {
    const svc = service(makeRepo({ ...admin, status: 'disabled' }));
    await expect(svc.login('admin@actionow.local', 'hunter2')).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects a non-admin (role=user) with unauthorized — no admin token for users', async () => {
    const svc = service(makeRepo({ ...admin, role: 'user' }));
    await expect(svc.login('admin@actionow.local', 'hunter2')).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });

  it('rejects an OAuth-only account (null password) with unauthorized', async () => {
    const svc = service(makeRepo({ ...admin, passwordHash: null }));
    await expect(svc.login('admin@actionow.local', 'hunter2')).rejects.toMatchObject({
      unified: { code: 'unauthorized' },
    });
  });
});

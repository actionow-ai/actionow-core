import type { AdminUserRecord, Database } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import type { AdminAuthRepo } from '../src/admin/auth/admin-auth.service.js';
import { AdminAuthService } from '../src/admin/auth/admin-auth.service.js';

const SECRET = 'test-admin-secret';

function makeRepo(admin: AdminUserRecord | undefined): AdminAuthRepo {
  return {
    findAdminByEmail: (_db: Database, email: string): Promise<AdminUserRecord | undefined> =>
      Promise.resolve(admin?.email === email ? admin : undefined),
  };
}

function service(repo: AdminAuthRepo): AdminAuthService {
  return new AdminAuthService({} as Database, repo, new JwtService({ secret: SECRET }), {
    ADMIN_JWT_SECRET: SECRET,
  } as never);
}

const admin: AdminUserRecord = {
  id: 'admin-1',
  email: 'admin@actionow.local',
  passwordHash: hashPassword('hunter2'),
  role: 'admin',
  status: 'active',
};

describe('AdminAuthService.login', () => {
  it('returns a JWT carrying sub + role for valid credentials', async () => {
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
});

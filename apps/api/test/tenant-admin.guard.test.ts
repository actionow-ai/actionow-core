import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { TenantAdminGuard } from '../src/console/tenant-admin.guard.js';

function ctx(tenantRole?: string): ExecutionContext {
  const req = { console: tenantRole ? { tenantRole } : undefined };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('TenantAdminGuard', () => {
  const g = new TenantAdminGuard();
  it('allows a tenant admin', () => {
    expect(g.canActivate(ctx('admin'))).toBe(true);
  });
  it('forbids a member', () => {
    expect(() => g.canActivate(ctx('member'))).toThrow();
  });
  it('forbids when no console context', () => {
    expect(() => g.canActivate(ctx())).toThrow();
  });
});

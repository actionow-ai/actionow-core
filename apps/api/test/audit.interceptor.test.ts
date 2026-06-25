import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Audit, AUDIT_META, type AuditSpec } from '../src/audit/audit.decorator.js';
import { AuditInterceptor } from '../src/audit/audit.interceptor.js';
import type { AuditService } from '../src/audit/audit.service.js';

function ctxOf(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function reflectorWith(spec: AuditSpec | undefined): Reflector {
  return { get: () => spec } as unknown as Reflector;
}

function handlerOf(result: unknown): CallHandler {
  return { handle: () => of(result) };
}

const SPEC: AuditSpec = {
  action: 'tenant.topup',
  target: 'account',
  resolve: ({ params, body }) => ({
    targetId: params.id ?? null,
    meta: { ...(body as Record<string, unknown>) },
  }),
};

describe('AuditInterceptor', () => {
  it('emits an operator-attributed record after a successful handler', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const audit = { record } as unknown as AuditService;
    const i = new AuditInterceptor(reflectorWith(SPEC), audit);
    const req = { admin: { adminId: 'op-1' }, params: { id: 'acc-1' }, body: { credits: 5 } };

    const out = await lastValueFrom(i.intercept(ctxOf(req), handlerOf({ account_id: 'acc-1' })));
    expect(out).toEqual({ account_id: 'acc-1' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'operator',
        actorId: 'op-1',
        action: 'tenant.topup',
        targetType: 'account',
        targetId: 'acc-1',
        meta: { credits: 5 },
      }),
    );
  });

  it('attributes a console request to the member actor + falls back to the console tenant', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const audit = { record } as unknown as AuditService;
    const i = new AuditInterceptor(
      reflectorWith({ action: 'api_key.create', target: 'api_key' }),
      audit,
    );
    const req = { console: { userId: 'user-9', tenantId: 't1' }, params: {}, body: {} };

    await lastValueFrom(i.intercept(ctxOf(req), handlerOf({ id: 'k1' })));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'member', actorId: 'user-9', tenantId: 't1' }),
    );
  });

  it('records the actor tenant role in meta.actor_tenant_role', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const audit = { record } as unknown as AuditService;
    const i = new AuditInterceptor(reflectorWith(SPEC), audit);
    const req = {
      console: { userId: 'user-9', tenantId: 't1', tenantRole: 'admin' },
      params: { id: 'acc-1' },
      body: { credits: 5 },
    };

    await lastValueFrom(i.intercept(ctxOf(req), handlerOf({ account_id: 'acc-1' })));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'member',
        actorId: 'user-9',
        tenantId: 't1',
        meta: expect.objectContaining({ actor_tenant_role: 'admin', credits: 5 }),
      }),
    );
  });

  it('is a passthrough when the handler has no @Audit spec', async () => {
    const record = vi.fn();
    const audit = { record } as unknown as AuditService;
    const i = new AuditInterceptor(reflectorWith(undefined), audit);
    const out = await lastValueFrom(i.intercept(ctxOf({ params: {} }), handlerOf('ok')));
    expect(out).toBe('ok');
    expect(record).not.toHaveBeenCalled();
  });

  it('the @Audit decorator stores the spec as handler metadata', () => {
    const target = { handler: () => 'ok' };
    Audit({ action: 'x.y', target: 'z' })(target, 'handler', {
      value: target.handler,
    });
    const spec = Reflect.getMetadata(AUDIT_META, target.handler) as AuditSpec | undefined;
    expect(spec).toMatchObject({ action: 'x.y', target: 'z' });
  });
});

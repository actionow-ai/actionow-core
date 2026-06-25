import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { AUDIT_META, type AuditResolveCtx, type AuditSpec } from './audit.decorator.js';
import { AuditService } from './audit.service.js';

interface OperatorReq {
  admin?: { adminId?: string };
  console?: { userId?: string; tenantId?: string; tenantRole?: string };
  params?: Record<string, string>;
  body?: unknown;
}

/**
 * Emits an audit_log row AFTER a `@Audit`-decorated handler returns successfully.
 * Resolves the actor from the guard-populated request (`req.admin` → operator,
 * `req.console` → member, else system), then runs the spec's `resolve` to extract
 * tenant/subject/target/meta. Best-effort via {@link AuditService} — a handler
 * error skips emission (the `tap` next-callback only runs on success), and an
 * audit write failure never disturbs the response.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<AuditSpec | undefined>(AUDIT_META, context.getHandler());
    if (spec === undefined) return next.handle();

    const req = context.switchToHttp().getRequest<OperatorReq>();
    const operatorId = req.admin?.adminId;
    const memberId = req.console?.userId;
    const actorType =
      operatorId !== undefined ? 'operator' : memberId !== undefined ? 'member' : 'system';
    const actorId = operatorId ?? memberId ?? null;
    // A member request is implicitly tenant-scoped by its console context.
    const fallbackTenantId = req.console?.tenantId ?? null;

    return next.handle().pipe(
      tap((result: unknown) => {
        const ctx: AuditResolveCtx = {
          req: req as unknown as Record<string, unknown>,
          result,
          params: req.params ?? {},
          body: req.body,
        };
        const r = spec.resolve?.(ctx) ?? {};
        const baseMeta =
          req.console?.tenantRole !== undefined
            ? { actor_tenant_role: req.console.tenantRole }
            : {};
        const meta = { ...baseMeta, ...(r.meta ?? {}) };
        void this.audit.record({
          actorType,
          actorId,
          tenantId: r.tenantId ?? fallbackTenantId,
          subjectId: r.subjectId ?? null,
          action: spec.action,
          targetType: spec.target,
          targetId: r.targetId ?? null,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        });
      }),
    );
  }
}

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
  member?: { subjectId?: string; tenantId?: string };
  params?: Record<string, string>;
  body?: unknown;
}

/**
 * Emits an audit_log row AFTER a `@Audit`-decorated handler returns successfully.
 * Resolves the actor from the guard-populated request against the
 * `audit_log.actor_type` vocabulary (`operator | member | system`):
 *   - `req.admin` (platform op) OR `req.console` (tenant op) → `operator`
 *   - `req.member` (an end-user subject on the /member plane) → `member`, with
 *     the subject as both actor and scope
 *   - neither → `system`
 * then runs the spec's `resolve` to extract tenant/subject/target/meta.
 * Best-effort via {@link AuditService} — a handler error skips emission (the
 * `tap` next-callback only runs on success), and an audit write failure never
 * disturbs the response.
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
    // Both platform admins and tenant-console users are OPERATORS; an end-user on
    // the /member plane is a MEMBER (the tenant/role meta below still separates a
    // tenant op from a platform op).
    const operatorId = req.admin?.adminId ?? req.console?.userId;
    const memberSubjectId = req.member?.subjectId;
    const actorType =
      operatorId !== undefined ? 'operator' : memberSubjectId !== undefined ? 'member' : 'system';
    const actorId = operatorId ?? memberSubjectId ?? null;
    // The tenant scope: a console op carries its tenant; a member carries its own.
    const fallbackTenantId = req.console?.tenantId ?? req.member?.tenantId ?? null;
    // A member action is self-scoped to its own subject.
    const fallbackSubjectId = req.member?.subjectId ?? null;

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
          subjectId: r.subjectId ?? fallbackSubjectId,
          action: spec.action,
          targetType: spec.target,
          targetId: r.targetId ?? null,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        });
      }),
    );
  }
}

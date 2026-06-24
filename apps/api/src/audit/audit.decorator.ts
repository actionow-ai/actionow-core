import { SetMetadata } from '@nestjs/common';

/** Context the {@link AuditSpec.resolve} function receives after a successful handler. */
export interface AuditResolveCtx {
  /** The request (carries `req.admin` for operators / `req.console` for members). */
  readonly req: Record<string, unknown>;
  /** The handler's return value. */
  readonly result: unknown;
  /** Route params. */
  readonly params: Record<string, string>;
  /** Request body. */
  readonly body: unknown;
}

/** What a resolver may pull out of the request/result for the audit row. */
export interface AuditResolved {
  tenantId?: string | null;
  subjectId?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown>;
}

/** Declarative audit spec attached to a handler via {@link Audit}. */
export interface AuditSpec {
  /** Dotted verb, e.g. `tenant.topup`. */
  readonly action: string;
  /** Target entity kind, e.g. `account`. */
  readonly target: string;
  /** Pull scope/target/meta out of the (req, result, params, body) after success. */
  readonly resolve?: (ctx: AuditResolveCtx) => AuditResolved;
}

export const AUDIT_META = 'audit:spec';

/**
 * Mark a mutation handler for audit logging. The {@link AuditInterceptor} reads
 * this metadata, resolves the actor from the request (operator vs member), runs
 * `resolve` to extract tenant/subject/target/meta, and best-effort appends an
 * audit_log row AFTER the handler succeeds (errors short-circuit — no record).
 */
export const Audit = (spec: AuditSpec): MethodDecorator => SetMetadata(AUDIT_META, spec);

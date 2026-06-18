import { type Database, getIdempotentResponse, putIdempotentResponse } from '@actionow/db';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { type Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

import { IDEMPOTENT_KEY } from './idempotent.decorator.js';
import { DB } from './tokens.js';

/**
 * The serialized-body byte cap. The cached admin responses are tiny (a created
 * entity view), but a response larger than this is NOT cached — the request
 * still succeeds, it just won't be replayable. A guard against an unbounded
 * jsonb blob landing in `request_idempotency`.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** The request header that opts a single request into replay. */
const HEADER = 'idempotency-key';

/**
 * Track D5 — `Idempotency-Key` replay for admin mutating POSTs.
 *
 * Acts ONLY when a request is (a) a POST, (b) carries a non-empty
 * `Idempotency-Key` header, AND (c) targets a route marked with the
 * `@Idempotent()` decorator. Any other request flows straight through.
 *
 * On a HIT (a prior response for this `(key, scope)` exists) it short-circuits:
 * the handler never runs and the stored `{status, body}` is replayed verbatim,
 * so a duplicate POST yields the same response — and creates no duplicate
 * entity. On a MISS it runs the handler and then, best-effort, persists the
 * fresh `{key, scope, status, body}`. A store failure (including a concurrent
 * in-flight duplicate that wrote first) is swallowed — it never fails the
 * request; the racing caller simply keeps its own freshly-computed response.
 *
 * `scope` is `METHOD path` (e.g. `POST /admin/tenants`), so the SAME key used
 * against a DIFFERENT route is independent (each route opts in and is keyed
 * separately).
 *
 * SECURITY: because the store persists the response BODY at rest, replay is
 * opt-in via `@Idempotent()` and is applied ONLY to NON-secret-returning admin
 * POSTs. Secret-returning endpoints (api-keys / secrets / oauth-sessions +
 * codex login / redemption-codes) are never decorated, so no plaintext secret
 * is ever cached here.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();

    // (a) POST + (c) route opted in via @Idempotent() + (b) non-empty header.
    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const key = idempotencyKeyHeader(req);
    if (req.method !== 'POST' || enabled !== true || key === undefined) {
      return next.handle();
    }

    const scope = scopeFor(req);

    // HIT → short-circuit and replay the stored response verbatim.
    const existing = await this.tryGet(key, scope);
    if (existing !== undefined) {
      const res = context.switchToHttp().getResponse<Response>();
      res.status(existing.status);
      return of(existing.body);
    }

    // MISS → run the handler, then persist the fresh response (best-effort).
    return next.handle().pipe(
      tap((body: unknown) => {
        const res = context.switchToHttp().getResponse<Response>();
        // The status NestJS will send (set by @HttpCode, else 200/201).
        const status = res.statusCode;
        void this.tryPut(key, scope, status, body);
      }),
    );
  }

  /** Read the cached response, swallowing any store error (best-effort). */
  private async tryGet(
    key: string,
    scope: string,
  ): Promise<{ status: number; body: unknown } | undefined> {
    try {
      return await getIdempotentResponse(this.db, key, scope);
    } catch (err) {
      this.logger.warn(`idempotency lookup failed for ${scope}: ${describe(err)}`);
      return undefined;
    }
  }

  /**
   * Persist the fresh response. Best-effort: a store failure (or a concurrent
   * in-flight duplicate that already inserted) must NOT fail the request. Skips
   * caching when the serialized body exceeds {@link MAX_BODY_BYTES}.
   */
  private async tryPut(key: string, scope: string, status: number, body: unknown): Promise<void> {
    try {
      if (oversized(body)) {
        this.logger.warn(`idempotency body too large to cache for ${scope}; skipping`);
        return;
      }
      await putIdempotentResponse(this.db, { key, scope, status, body: body ?? null });
    } catch (err) {
      this.logger.warn(`idempotency store failed for ${scope}: ${describe(err)}`);
    }
  }
}

/** The non-empty `Idempotency-Key` header value, or `undefined`. */
export function idempotencyKeyHeader(req: Request): string | undefined {
  const raw = req.headers[HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The `METHOD path` scope key. Uses the concrete request path (sans query
 * string), so a key reused on a different route — or a different resource id
 * within a parameterized route — is keyed independently.
 */
function scopeFor(req: Request): string {
  const path = req.originalUrl.split('?')[0] ?? req.path;
  return `${req.method} ${path}`;
}

/** True when the JSON-serialized body exceeds the cache cap. */
function oversized(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES;
  } catch {
    // Non-serializable → don't attempt to cache it.
    return true;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

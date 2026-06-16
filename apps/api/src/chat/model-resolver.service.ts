import type { Database } from '@actionow/db';
import { resolveModelForTenant } from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import { engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';

/**
 * Track C's pinned model-resolution shape (do NOT rename), assignable from the
 * `@actionow/db` `ResolvedModel` (`capabilities: Record<string, boolean>` ⊆
 * `Record<string, unknown>`).
 */
export interface ResolvedModel {
  readonly modelId: string;
  readonly resourceId: string;
  readonly inputPrice: bigint;
  readonly outputPrice: bigint;
  readonly capabilities: Record<string, unknown>;
}

/** DI token for the (Track-C-backed) {@link ModelResolverPort} provider. */
export const MODEL_RESOLVER = Symbol('MODEL_RESOLVER');

/**
 * The seam the {@link ModelResolverService} resolves a model name through.
 * Track C's `@actionow/db` `resolveModelForTenant` is the production binding
 * ({@link realModelResolverPort}); tests override it with a fake.
 */
export interface ModelResolverPort {
  resolveModelForTenant(
    db: Database,
    modelName: string,
    tenantId: string,
  ): Promise<ResolvedModel | undefined>;
}

/**
 * The real {@link ModelResolverPort} (Track C, MERGED): delegates to the
 * `@actionow/db` `resolveModelForTenant` repo (visibility-gated in SQL: `active`
 * + `public` OR a `model_grant` for the tenant). Returns `undefined` for an
 * unknown/ungranted model, which the service turns into `resource_not_found`.
 */
export const realModelResolverPort: ModelResolverPort = {
  resolveModelForTenant: (db, modelName, tenantId) =>
    resolveModelForTenant(db, modelName, tenantId),
};

/**
 * A fake {@link ModelResolverPort} for test overrides: resolves a fixed set of
 * model names to pre-built {@link ResolvedModel}s, returning `undefined` for
 * anything else (→ `resource_not_found`).
 */
export function fakeModelResolverPort(models: Record<string, ResolvedModel>): ModelResolverPort {
  return {
    resolveModelForTenant: (_db, modelName) => Promise.resolve(models[modelName]),
  };
}

/**
 * Resolves a public model `name` (the string a caller sends in the request
 * body / URL) to its routing+pricing handle for a tenant, via the injected
 * {@link ModelResolverPort}. An unknown/ungranted model → `resource_not_found`
 * (404), surfaced through the {@link UnifiedErrorFilter}.
 */
@Injectable()
export class ModelResolverService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MODEL_RESOLVER) private readonly port: ModelResolverPort,
  ) {}

  async resolve(modelName: string, tenantId: string): Promise<ResolvedModel> {
    const m = await this.port.resolveModelForTenant(this.db, modelName, tenantId);
    if (m === undefined) throw engineNotFound(`model "${modelName}" not found`);
    return m;
  }
}

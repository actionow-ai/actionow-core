import type { Database } from '@actionow/db';
import { DifyParseError } from '@actionow/dify';
import type { RegisterResult } from '@actionow/engine';
import { DifyRegistrationError, DifyRegistrationService, EngineError } from '@actionow/engine';
import { Inject, Injectable } from '@nestjs/common';

import { DB, KNOWN_MODELS } from '../common/tokens.js';
import type { DifyImportDto } from './dto/admin.dto.js';

/**
 * Wraps the engine's {@link DifyRegistrationService} for the admin HTTP surface
 * (`POST /admin/dify/import`). It maps the registration domain errors onto the
 * §4.7 unified envelope so {@link UnifiedErrorFilter} renders a clean response:
 *
 * - `metered_not_allowed` (BYO + metered, review #2 / §7.3) → 400 `invalid_input`
 *   with the `metered_not_allowed` code preserved in the message.
 * - a blocked workflow (e.g. knowledge-retrieval node) without `allowBlockers`
 *   → 422 `content_filtered` carrying the human-readable blocker details.
 *
 * The `knownModels` set (Dify `provider/name` keys with a gateway mapping) is
 * injected so it can be configured/extended without touching this service;
 * it defaults to empty (an unknown model is a `warn`, not a `block`).
 */
@Injectable()
export class AdminDifyService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(KNOWN_MODELS) private readonly knownModels: ReadonlySet<string>,
  ) {}

  async import(dto: DifyImportDto): Promise<RegisterResult> {
    const service = new DifyRegistrationService({ db: this.db, knownModels: this.knownModels });
    try {
      return await service.register({
        tenantId: dto.tenantId,
        resourceId: dto.resourceId,
        yamlText: dto.yaml,
        endpoint: dto.endpoint,
        serviceKeyRef: dto.serviceKeyRef ?? null,
        pricingModel: dto.pricingModel,
        allowBlockers: dto.allowBlockers,
      });
    } catch (err: unknown) {
      throw mapDifyError(err);
    }
  }
}

/**
 * Translate a Dify parse/registration error into a unified `EngineError` so the
 * global filter renders the §4.7 envelope. `metered_not_allowed` and the other
 * parse failures become 400 `invalid_input` (the machine code stays in the
 * message); a blocker rejection becomes 422 `content_filtered`. Anything else is
 * rethrown unchanged for the filter's `internal_error` fallback.
 */
function mapDifyError(err: unknown): unknown {
  if (err instanceof DifyParseError) {
    // The message already carries the machine code (e.g. "metered_not_allowed: …").
    return new EngineError({ code: 'invalid_input', message: err.message, retryable: false });
  }
  if (err instanceof DifyRegistrationError) {
    return new EngineError({
      code: 'content_filtered',
      message: `registration_blocked: ${err.blockers.join('; ')}`,
      retryable: false,
    });
  }
  return err;
}

import { randomUUID } from 'node:crypto';

import {
  type ModerationRequest,
  moderationRequestSchema,
  type ModerationResponse,
  type ModerationResult,
} from '@actionow/contracts';
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ModerationRelayService } from './moderation-relay.service.js';

/**
 * OpenAI-compatible moderations relay: `POST /v1/moderations`. A downstream caller
 * can point the OpenAI SDK's `base_url` here and call `client.moderations.create(
 * { model, input })` unchanged. Resolves the model → routes to a channel → calls
 * the upstream provider's `/moderations`, billed per INPUT token against the wallet
 * (hold → settle) through the SAME engine machinery as the chat relay. Feeds the
 * compliance moat.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/moderations')
export class ModerationsController {
  constructor(
    private readonly relay: ModerationRelayService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible moderations (billed per input token)' })
  async create(
    @Body(new ZodBody(moderationRequestSchema)) ir: ModerationRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ModerationResponse> {
    const ctx = this.auth.resolve(req);
    const idem = idempotencyKeyHeader(req);
    const routeTag = routeTagHeader(req);
    const { result, servedBy } = await this.relay.moderate(ir.model, ir, ctx, idem, routeTag);
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);
    return renderModeration(result, ir.model);
  }
}

/**
 * Render the dialect-neutral {@link ModerationResult} into the OpenAI wire shape.
 * The OpenAI `id` is a synthesized per-response identifier (`modr-<uuid>`); the
 * upstream's own id is not surfaced through the IR, mirroring OpenAI's opaque id.
 */
function renderModeration(result: ModerationResult, model: string): ModerationResponse {
  return {
    id: `modr-${randomUUID()}`,
    model,
    results: result.results.map((r) => ({
      flagged: r.flagged,
      categories: r.categories,
      category_scores: r.categoryScores,
    })),
  };
}

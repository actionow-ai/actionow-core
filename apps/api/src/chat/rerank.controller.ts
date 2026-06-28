import {
  type RerankRequest,
  rerankRequestSchema,
  type RerankResponse,
  type RerankResult,
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
import { RerankRelayService } from './rerank-relay.service.js';

/**
 * Cohere/Jina-compatible rerank relay: `POST /v1/rerank`. Resolves the model →
 * routes to a channel → calls the upstream provider's `/rerank`, scoring each
 * document against the query, billed per INPUT token (query + documents) against
 * the wallet (hold → settle) through the SAME engine machinery as the chat relay.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/rerank')
export class RerankController {
  constructor(
    private readonly relay: RerankRelayService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cohere/Jina-compatible rerank (billed per input token)' })
  async create(
    @Body(new ZodBody(rerankRequestSchema)) ir: RerankRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RerankResponse> {
    const ctx = this.auth.resolve(req);
    const idem = idempotencyKeyHeader(req);
    const routeTag = routeTagHeader(req);
    const { result, servedBy } = await this.relay.rerank(ir.model, ir, ctx, idem, routeTag);
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);
    return renderRerank(result, ir.model);
  }
}

/** Render the dialect-neutral {@link RerankResult} into the Cohere/Jina wire shape. */
function renderRerank(result: RerankResult, model: string): RerankResponse {
  return {
    model,
    results: result.results.map((r) => {
      const item: RerankResponse['results'][number] = {
        index: r.index,
        relevance_score: r.relevanceScore,
      };
      if (r.document !== undefined) item.document = r.document;
      return item;
    }),
    // Rerank bills on INPUT tokens only.
    usage: { input_tokens: result.usage.inputTokens },
  };
}

import {
  type EmbeddingsRequest,
  embeddingsRequestSchema,
  type EmbeddingsResponse,
  type EmbeddingsResult,
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
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';
import { EmbedRelayService } from './embed-relay.service.js';

/**
 * OpenAI-compatible embeddings relay: `POST /v1/embeddings`. A downstream caller
 * can point the OpenAI SDK's `base_url` here and call `client.embeddings.create(
 * { model, input })` unchanged. Resolves the model → routes to a channel → calls
 * the upstream provider's `/v1/embeddings`, billed per INPUT token against the
 * wallet (hold → settle) through the SAME engine machinery as the chat relay.
 *
 * 切换预案③ (批次5 slice3, 双面并存): the ONE branch below routes a
 * gray-released tenant (预案② `isV2Tenant`) through the NEW supply gateway
 * ({@link GatewayChatV2Service}, on the RAW `req.body` wire) end to end; every
 * other tenant rides the untouched legacy relay path.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/embeddings')
export class EmbeddingsController {
  constructor(
    private readonly relay: EmbedRelayService,
    private readonly auth: AuthService,
    private readonly gatewayV2: GatewayChatV2Service,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible embeddings (billed per input token)' })
  async create(
    @Body(new ZodBody(embeddingsRequestSchema)) ir: EmbeddingsRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EmbeddingsResponse | Record<string, unknown> | undefined> {
    const ctx = this.auth.resolve(req);
    if (await this.gatewayV2.isV2Tenant(ctx.tenantId)) {
      return this.gatewayV2.embeddings((req.body ?? {}) as Record<string, unknown>, req, res);
    }
    const idem = idempotencyKeyHeader(req);
    const routeTag = routeTagHeader(req);
    const { result, servedBy } = await this.relay.embed(ir.model, ir, ctx, idem, routeTag);
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);
    return renderOpenAIEmbeddings(result, ir.model);
  }
}

/** Render the dialect-neutral {@link EmbeddingsResult} into the OpenAI wire shape. */
function renderOpenAIEmbeddings(result: EmbeddingsResult, model: string): EmbeddingsResponse {
  const promptTokens = result.usage.inputTokens;
  return {
    object: 'list',
    data: result.vectors.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    model,
    // Embeddings bill on INPUT tokens only, so total_tokens === prompt_tokens.
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

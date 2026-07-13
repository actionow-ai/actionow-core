import { parseOpenAIChat, renderOpenAIChat, renderOpenAIChatStream } from '@actionow/llm-protocol';
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';
import { ChatRelayService } from './chat-relay.service.js';
import { pipeSse } from './sse.js';

/**
 * OpenAI-compatible chat relay: `POST /v1/chat/completions`. Parses the wire
 * body into the neutral IR, drives the engine via {@link ChatRelayService}
 * (resolve model → hold → run → settle-once), and renders the IR back to the
 * OpenAI dialect (`chat.completion` JSON, or `chat.completion.chunk` SSE ending
 * `data: [DONE]`). The hold runs inside `chatStream` BEFORE any SSE byte, so
 * insufficient_credits/invalid_input surface as real HTTP errors.
 *
 * 切换预案③ (批次5 slice3, 双面并存): the ONE branch below routes a
 * gray-released tenant (预案② `isV2Tenant`) through the NEW supply gateway
 * ({@link GatewayChatV2Service}) end to end; every other tenant rides the
 * untouched legacy relay path. The two worlds never bridge.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1/chat')
export class OpenAIChatController {
  constructor(
    private readonly relay: ChatRelayService,
    private readonly auth: AuthService,
    private readonly gatewayV2: GatewayChatV2Service,
  ) {}

  @Post('completions')
  @HttpCode(200)
  async completions(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    const ctx = this.auth.resolve(req);
    if (await this.gatewayV2.isV2Tenant(ctx.tenantId)) {
      return this.gatewayV2.completions(body, req, res);
    }
    const ir = parseOpenAIChat(body);
    const idem = idempotencyKeyHeader(req);
    const routeTag = routeTagHeader(req);
    if (body.stream === true) {
      // The relay may degrade across the model fallback chain pre-commit, so the
      // committed model can differ from `ir.model`; label the chunks with the
      // SERVED model (parity with the blocking path).
      const { events, servedModel } = await this.relay.chatStream(
        ir.model,
        ir,
        ctx,
        idem,
        routeTag,
      );
      await pipeSse(res, renderOpenAIChatStream(events, servedModel ?? ir.model));
      return undefined;
    }
    const { response, servedBy, servedModel } = await this.relay.chat(
      ir.model,
      ir,
      ctx,
      idem,
      routeTag,
    );
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);
    // Label the response with the SERVED model — the relay may have degraded
    // across the model fallback chain (parity with the streaming path).
    return renderOpenAIChat(response, servedModel ?? ir.model);
  }
}

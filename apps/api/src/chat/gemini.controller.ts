import {
  parseGeminiChat,
  renderGeminiChat,
  renderGeminiGenerateContentStream,
} from '@actionow/llm-protocol';
import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { idempotencyKeyHeader } from '../common/idempotency.interceptor.js';
import { routeTagHeader } from '../common/route-tag.js';
import { ChatRelayService } from './chat-relay.service.js';
import { pipeSse } from './sse.js';

/**
 * Gemini-compatible chat relay under `/v1beta/models`. Gemini carries the model
 * in the URL path with a `:action` suffix (`/{model}:generateContent` and
 * `/{model}:streamGenerateContent`); the literal colon is escaped in the route
 * so the `:model` param captures only the model name. Parses the wire body +
 * URL model into the neutral IR, drives the engine via {@link ChatRelayService},
 * and renders the IR back to Gemini's dialect (`candidates[]` JSON, or `alt=sse`
 * `data:` candidate frames). The hold runs inside `chatStream` BEFORE any byte.
 */
@ApiTags('v1beta')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, GovernanceGuard)
@Controller('v1beta/models')
export class GeminiChatController {
  constructor(
    private readonly relay: ChatRelayService,
    private readonly auth: AuthService,
  ) {}

  @Post(':model\\:generateContent')
  @HttpCode(200)
  async generateContent(
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const ctx = this.auth.resolve(req);
    const ir = parseGeminiChat(body, model);
    const { response, servedBy } = await this.relay.chat(
      ir.model,
      ir,
      ctx,
      idempotencyKeyHeader(req),
      routeTagHeader(req),
    );
    if (servedBy !== undefined) res.setHeader('x-actionow-channel', servedBy.providerType);
    return renderGeminiChat(response);
  }

  @Post(':model\\:streamGenerateContent')
  async streamGenerateContent(
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ctx = this.auth.resolve(req);
    const ir = parseGeminiChat(body, model);
    // The relay still walks the model fallback chain pre-commit (a degraded model
    // may serve the committed stream); Gemini's streaming frames carry no
    // top-level model field, so the renderer takes no served-model arg — the
    // served model is recorded on the usage_log/relay_trace by the engine.
    const { events } = await this.relay.chatStream(
      ir.model,
      ir,
      ctx,
      idempotencyKeyHeader(req),
      routeTagHeader(req),
    );
    await pipeSse(res, renderGeminiGenerateContentStream(events));
  }
}

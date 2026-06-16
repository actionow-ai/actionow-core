import {
  parseAnthropicChat,
  renderAnthropicChat,
  renderAnthropicMessagesStream,
} from '@actionow/llm-protocol';
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { ChatRelayService } from './chat-relay.service.js';
import { pipeSse } from './sse.js';

/**
 * Anthropic-compatible chat relay: `POST /v1/messages`. Parses the wire body
 * into the neutral IR, drives the engine via {@link ChatRelayService}, and
 * renders the IR back to the Anthropic dialect (`type:'message'` JSON, or the
 * typed streaming events `event: message_start`…`event: message_stop`). The
 * hold runs inside `chatStream` BEFORE any SSE byte.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@Controller('v1')
export class AnthropicChatController {
  constructor(
    private readonly relay: ChatRelayService,
    private readonly auth: AuthService,
  ) {}

  @Post('messages')
  @HttpCode(200)
  async messages(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    const ctx = this.auth.resolve(req);
    const ir = parseAnthropicChat(body);
    if (body.stream === true) {
      const { events } = await this.relay.chatStream(ir.model, ir, ctx);
      await pipeSse(res, renderAnthropicMessagesStream(events, ir.model));
      return undefined;
    }
    const { response } = await this.relay.chat(ir.model, ir, ctx);
    return renderAnthropicChat(response, ir.model);
  }
}

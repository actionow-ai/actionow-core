import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * Anthropic-compatible chat: `POST /v1/messages`, served END TO END by the NEW
 * supply gateway ({@link GatewayChatV2Service}): Anthropic wire → §4.1 layer-1
 * 归一 → gateway.execute → Anthropic rendering (`type:'message'` JSON, or the
 * typed streaming events `event: message_start`…`event: message_stop`).
 *
 * 批次6 D2: the 切换预案②③ gray-release branch is collapsed — always-new.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class AnthropicChatController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post('messages')
  @HttpCode(200)
  async messages(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.gatewayV2.messages(body, req, res);
  }
}

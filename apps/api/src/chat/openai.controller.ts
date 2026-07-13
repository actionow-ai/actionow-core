import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * OpenAI-compatible chat: `POST /v1/chat/completions`, served END TO END by the
 * NEW supply gateway ({@link GatewayChatV2Service}): §4.1 layer-1 wire 归一 →
 * gateway.execute (§7.8 gates / §8 routing / §9.2 settle) → OpenAI wire
 * rendering (chat.completion JSON, or chunk SSE ending `data: [DONE]`).
 *
 * 批次6 D2: the 切换预案②③ per-tenant gray-release branch is COLLAPSED — the
 * legacy relay world is deleted, every tenant rides the new gateway. Only
 * ApiKeyGuard mounts here: the §7.8 gates inside planExecution own the
 * new-world 限流/额度 (the create.controller 择稳裁决).
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/chat')
export class OpenAIChatController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post('completions')
  @HttpCode(200)
  async completions(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.gatewayV2.completions(body, req, res);
  }
}

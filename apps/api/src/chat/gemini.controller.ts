import { Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * Gemini-compatible chat under `/v1beta/models`, served END TO END by the NEW
 * supply gateway ({@link GatewayChatV2Service}). Gemini carries the model in
 * the URL path with a `:action` suffix (`/{model}:generateContent` and
 * `/{model}:streamGenerateContent`); the literal colon is escaped in the route
 * so the `:model` param captures only the model name.
 *
 * 批次6 D2: the 切换预案②③ gray-release branch is collapsed — always-new.
 */
@ApiTags('v1beta')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1beta/models')
export class GeminiChatController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post(':model\\:generateContent')
  @HttpCode(200)
  async generateContent(
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.gatewayV2.generateContent(model, body, req, res);
  }

  @Post(':model\\:streamGenerateContent')
  async streamGenerateContent(
    @Param('model') model: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.gatewayV2.streamGenerateContent(model, body, req, res);
  }
}

import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * OpenAI-compatible moderations: `POST /v1/moderations`, served END TO END by
 * the NEW supply gateway ({@link GatewayChatV2Service}) on the raw wire body.
 * Feeds the compliance moat.
 *
 * 批次6 D2: the 切换预案②③ gray-release branch is collapsed — always-new.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/moderations')
export class ModerationsController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'OpenAI-compatible moderations (billed per input token)' })
  async create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.gatewayV2.moderations(body, req, res);
  }
}

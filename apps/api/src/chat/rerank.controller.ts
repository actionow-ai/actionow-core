import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { GatewayChatV2Service } from '../gateway/chat-v2.service.js';

/**
 * Cohere/Jina-compatible rerank: `POST /v1/rerank`, served END TO END by the
 * NEW supply gateway ({@link GatewayChatV2Service}) on the raw wire body.
 *
 * 批次6 D2: the 切换预案②③ gray-release branch is collapsed — always-new.
 */
@ApiTags('v1')
@ApiBearerAuth('api-key')
@UseGuards(ApiKeyGuard)
@Controller('v1/rerank')
export class RerankController {
  constructor(private readonly gatewayV2: GatewayChatV2Service) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cohere/Jina-compatible rerank (billed per input token)' })
  async create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown> | undefined> {
    return this.gatewayV2.rerank(body, req, res);
  }
}

// apps/api/src/gateway/gateway-callbacks.controller.ts
//
// model-supply-greenfield 批次4 slice4 — the NEW-WORLD upstream-callback
// ingress edge (§3). `POST /v1/gateway/callbacks/:offeringId` is NOT behind
// the ApiKeyGuard: the dialect's aspect-⑥ signature verification over the
// RAW request bytes is the authentication (the old /v1/callbacks route stays
// untouched — 双面并存). The :offeringId path segment pins dialect + channel
// WITHOUT parsing the body, so the SPI's verify-before-parse order holds at
// the edge.
import type { RawBodyRequest } from '@nestjs/common';
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { engineUnauthorized } from '../common/errors.js';
import type { CallbackIngestResult } from './gateway-callbacks.service.js';
import { GatewayCallbacksService } from './gateway-callbacks.service.js';

@ApiTags('v1')
@Controller('v1/gateway/callbacks')
export class GatewayCallbacksController {
  constructor(private readonly callbacks: GatewayCallbacksService) {}

  @Post(':offeringId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ingest a signed upstream task callback (aspect-⑥ verified, §3 双保险 fast path)',
  })
  async ingest(
    @Param('offeringId') offeringId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CallbackIngestResult> {
    // Signature verification runs over the EXACT received bytes (`rawBody`,
    // populated by the app's `rawBody: true`); a re-serialization of the
    // parsed JSON would not byte-match.
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      throw engineUnauthorized('callback body missing');
    }
    return this.callbacks.ingest(offeringId, rawBody, req.headers, new Date());
  }
}

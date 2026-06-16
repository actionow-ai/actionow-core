import type { RawBodyRequest } from '@nestjs/common';
import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { engineUnauthorized } from '../common/errors.js';
import { CallbacksService } from './callbacks.service.js';

/** The 200 acknowledgement for an accepted (verified) async callback. */
interface CallbackAck {
  status: 'accepted';
  settled: boolean;
}

/**
 * Async-callback ingress (§Phase 8). `POST /v1/callbacks/:provider` is **not**
 * behind the ApiKeyGuard — the per-channel HMAC over the raw request body is the
 * authentication. A verified payload is routed to the engine's dedup-safe
 * handler; a bad/missing signature is a 401 (`unauthorized`).
 */
@ApiTags('v1')
@Controller('v1/callbacks')
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}

  @Post(':provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ingest a signed upstream async callback (HMAC-verified)' })
  async ingest(
    @Param('provider') _provider: string,
    @Body() parsedBody: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CallbackAck> {
    // The HMAC is computed over the EXACT received bytes; re-serializing the
    // parsed JSON would not byte-match. `rawBody` is populated by the app's
    // `rawBody: true` option.
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      throw engineUnauthorized('callback body missing');
    }
    const result = await this.callbacks.ingest(rawBody, parsedBody, req.headers, new Date());
    return { status: 'accepted', settled: result.settled };
  }
}

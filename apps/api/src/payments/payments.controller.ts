import { paymentProviderSchema } from '@actionow/contracts';
import { InvalidInputError, SignatureVerificationError } from '@actionow/payments';
import type { RawBodyRequest } from '@nestjs/common';
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type CreateIntentBodyDto, createIntentBodySchema } from './dto/payments.dto.js';
import type { CreateIntentResponse, PaymentIntentView } from './payments.service.js';
import { PaymentsService } from './payments.service.js';

/** The 200 acknowledgement for an accepted (signature-verified) webhook. */
interface WebhookAck {
  status: 'ok';
  /** `true` for the delivery that fulfilled; `false` for a duplicate no-op. */
  fulfilled: boolean;
}

/**
 * The `/v1/payments` surface (Phase 10).
 *
 * - `POST /intents` (ApiKeyGuard): create a payment intent for the caller's
 *   tenant; returns the provider checkout handle.
 * - `POST /webhooks/:provider` (**NO** ApiKeyGuard): the provider signature over
 *   the raw body is the auth. A verified delivery fulfills exactly once and
 *   returns 200 (processed OR duplicate); a bad/missing signature is a 401.
 *   Fulfillment happens ONLY here — never on a redirect return.
 * - `GET /intents/:id` (ApiKeyGuard): tenant-scoped read (cross-tenant → 404).
 *
 * Provider errors are translated to the §4.7 envelope: a
 * {@link SignatureVerificationError} → 401, an {@link InvalidInputError} (e.g.
 * an unconfigured provider) → 400. No secret/signature/key is ever logged.
 */
@ApiTags('v1')
@Controller('v1/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly auth: AuthService,
  ) {}

  @Post('intents')
  @HttpCode(201)
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Create a payment intent (returns a checkout handle)' })
  async createIntent(
    @Body(new ZodBody(createIntentBodySchema)) dto: CreateIntentBodyDto,
    @Req() req: Request,
  ): Promise<CreateIntentResponse> {
    const ctx = this.auth.resolve(req);
    try {
      return await this.payments.createIntent(dto, ctx);
    } catch (err) {
      throw translateProviderError(err);
    }
  }

  @Post('webhooks/:provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ingest a signed payment webhook (signature-verified)' })
  async webhook(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<WebhookAck> {
    // The signature is computed over the EXACT received bytes; re-serializing
    // the parsed JSON would not byte-match. `rawBody` is populated by the app's
    // `rawBody: true` option.
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      throw engineUnauthorized('webhook body missing');
    }
    const kind = paymentProviderSchema.safeParse(provider);
    if (!kind.success) {
      throw engineInvalidInput(`unknown payment provider '${provider}'`);
    }

    try {
      const result = await this.payments.handleWebhook(kind.data, rawBody, req.headers);
      return { status: 'ok', fulfilled: 'fulfilled' in result };
    } catch (err) {
      throw translateProviderError(err);
    }
  }

  @Get('intents/:id')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Get a payment intent (tenant-scoped)' })
  async getIntent(@Param('id') id: string, @Req() req: Request): Promise<PaymentIntentView> {
    const ctx = this.auth.resolve(req);
    return this.payments.getIntent(id, ctx);
  }
}

/**
 * Map a payment-provider error to the unified envelope: a bad/missing signature
 * is `unauthorized` (401); an unconfigured/malformed provider request is
 * `invalid_input` (400). Any other error is re-thrown unchanged so the global
 * filter renders a sanitized 500.
 */
function translateProviderError(err: unknown): unknown {
  if (err instanceof SignatureVerificationError) {
    return engineUnauthorized('webhook signature verification failed');
  }
  if (err instanceof InvalidInputError) {
    return engineInvalidInput(err.message);
  }
  return err;
}

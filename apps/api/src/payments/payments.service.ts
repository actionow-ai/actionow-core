import type { PaymentProviderKind } from '@actionow/contracts';
import type { Database, PaymentIntentRow } from '@actionow/db';
import { getIntentByIdForTenant, listIntentsByTenant } from '@actionow/db';
import type { HandleWebhookResult, PaymentService } from '@actionow/engine';
import type { WebhookHeaders } from '@actionow/payments';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineNotFound } from '../common/errors.js';
import { DB, PAYMENTS } from '../common/tokens.js';
import type { CreateIntentBodyDto } from './dto/payments.dto.js';

/** The public JSON view of a `payment_intent` (money as decimal strings). */
export interface PaymentIntentView {
  id: string;
  tenant_id: string;
  provider: string;
  provider_ref: string;
  purpose: string;
  target_ref: string | null;
  amount_minor: string;
  currency: string;
  credit_amount: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** The body of a successful `POST /v1/payments/intents`. */
export interface CreateIntentResponse {
  intent_id: string;
  redirect_url?: string;
  qr?: string;
}

/**
 * The `/v1/payments` application service: a thin tenant-scoped wrapper over the
 * engine {@link PaymentService} (create + verified webhook fulfillment) plus the
 * tenant-scoped intent reads. The money/idempotency logic all lives in the
 * engine; this layer only maps DTOs ⇆ views and enforces tenant scope on reads.
 *
 * No secret, signature, or key is ever logged here.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PAYMENTS) private readonly payments: PaymentService,
  ) {}

  /** Create a payment intent for the caller's tenant. */
  async createIntent(body: CreateIntentBodyDto, ctx: TenantContext): Promise<CreateIntentResponse> {
    const result = await this.payments.createIntent({
      tenantId: ctx.tenantId,
      provider: body.provider,
      purpose: body.purpose,
      amountMinor: BigInt(body.amount_minor),
      currency: body.currency,
      ...(body.target_ref !== undefined ? { targetRef: body.target_ref } : {}),
    });
    return {
      intent_id: result.intentId,
      ...(result.redirectUrl !== undefined ? { redirect_url: result.redirectUrl } : {}),
      ...(result.qr !== undefined ? { qr: result.qr } : {}),
    };
  }

  /**
   * Handle a verified provider webhook. Delegates to the engine, which verifies
   * the signature (a throw here propagates so the controller returns 401) and
   * fulfills exactly once. Fulfillment happens ONLY on this path.
   */
  async handleWebhook(
    provider: PaymentProviderKind,
    rawBody: Buffer | string,
    headers: WebhookHeaders,
  ): Promise<HandleWebhookResult> {
    return this.payments.handleWebhook(provider, rawBody, headers);
  }

  /** Fetch one of the caller-tenant's intents, or 404 (cross-tenant → 404). */
  async getIntent(id: string, ctx: TenantContext): Promise<PaymentIntentView> {
    const intent = await getIntentByIdForTenant(this.db, id, ctx.tenantId);
    if (intent === undefined) {
      throw engineNotFound(`payment intent ${id} not found`);
    }
    return toIntentView(intent);
  }

  /** List a tenant's intents (admin view). */
  async listIntents(tenantId: string, limit: number): Promise<PaymentIntentView[]> {
    const rows = await listIntentsByTenant(this.db, tenantId, limit);
    return rows.map(toIntentView);
  }
}

/** Project a `payment_intent` row to its public view (bigint money → strings). */
function toIntentView(row: PaymentIntentRow): PaymentIntentView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    provider: row.provider,
    provider_ref: row.providerRef,
    purpose: row.purpose,
    target_ref: row.targetRef,
    amount_minor: row.amountMinor.toString(),
    currency: row.currency,
    credit_amount: row.creditAmount === null ? null : row.creditAmount.toString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

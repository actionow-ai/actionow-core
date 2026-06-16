import type {
  CreateIntentInput as ProviderCreateIntentInput,
  PaymentProviderKind,
  PaymentPurpose,
  VerifiedEvent,
} from '@actionow/contracts';
import {
  createIntent as createIntentRow,
  type DbOrTx,
  getAccountByTenant,
  getIntentByProviderRef,
  insertEventIfNew,
  markEventProcessed,
  setIntentStatus,
  topUp,
} from '@actionow/db';
import type { PaymentRegistry, WebhookHeaders } from '@actionow/payments';

import { engineError } from './errors.js';

export interface PaymentServiceDeps {
  db: DbOrTx;
  /** Resolved set of configured payment providers (Stripe real + stubs). */
  providers: PaymentRegistry;
  /**
   * µcredits granted per one currency *minor unit* (e.g. 1000 → 1 USD cent buys
   * 1000 µcredits). Fixed at intent creation and persisted on the intent so a
   * later rate change never re-prices an in-flight topup.
   */
  creditRate: bigint;
}

/** What a caller passes to {@link PaymentService.createIntent}. */
export interface CreatePaymentIntentInput {
  tenantId: string;
  provider: PaymentProviderKind;
  purpose: PaymentPurpose;
  /** Integer count of the currency's minor unit (cents, fen, …). */
  amountMinor: bigint;
  currency: string;
  /** Links a non-topup intent to a domain object (e.g. an order id). */
  targetRef?: string | undefined;
}

/** The result of creating an intent: the persisted id + the checkout handle. */
export interface CreatePaymentIntentResult {
  intentId: string;
  redirectUrl?: string | undefined;
  qr?: string | undefined;
}

/**
 * The outcome of handling a verified webhook. `duplicate` is a redelivery the
 * `unique(provider, event_id)` short-circuited (no-op, still a 200). `fulfilled`
 * means this delivery transitioned the intent and ran fulfillment.
 */
export type HandleWebhookResult = { duplicate: true } | { fulfilled: true };

/**
 * Orchestrates the payment lifecycle (§Phase 10): create an intent against a
 * provider then fulfill it from a signature-verified webhook, exactly once.
 *
 * The exactly-once guarantee rests on two database facts, never on application
 * timing:
 *  - `insertEventIfNew` does `ON CONFLICT (provider, provider_event_id) DO
 *    NOTHING`, so a redelivered webhook is recognized as a duplicate and no-ops.
 *  - fulfillment (credit the ledger + transition the intent + mark the event
 *    processed) runs in ONE transaction, so a crash mid-fulfillment rolls the
 *    whole thing back and the redelivery re-runs it cleanly.
 *
 * No NestJS, no HTTP — apps wrap this plain service. Fulfillment happens ONLY
 * here (a webhook), never on a redirect return.
 */
export class PaymentService {
  private readonly deps: PaymentServiceDeps;

  constructor(deps: PaymentServiceDeps) {
    this.deps = deps;
  }

  /**
   * Create a payment intent: ask the provider for a checkout handle, then
   * persist a `payment_intent` in status `created`. For a `topup` the µcredit
   * `creditAmount` is computed here (amountMinor × creditRate) and frozen on the
   * row; non-topup intents carry no credit amount (fulfillment marks the order).
   */
  async createIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult> {
    const provider = this.deps.providers.get(input.provider);

    const creditAmount =
      input.purpose === 'topup' ? input.amountMinor * this.deps.creditRate : null;

    const providerInput: ProviderCreateIntentInput = {
      tenantId: input.tenantId,
      provider: input.provider,
      purpose: input.purpose,
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
    };

    const result = await provider.createIntent(providerInput);

    const intent = await createIntentRow(this.deps.db, {
      tenantId: input.tenantId,
      provider: input.provider,
      providerRef: result.providerRef,
      purpose: input.purpose,
      targetRef: input.targetRef ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      creditAmount,
      idempotencyKey: null,
    });

    return {
      intentId: intent.id,
      ...(result.redirectUrl !== undefined ? { redirectUrl: result.redirectUrl } : {}),
      ...(result.qr !== undefined ? { qr: result.qr } : {}),
    };
  }

  /**
   * Handle an inbound provider webhook. Verifies the signature (a throw here
   * propagates — the caller maps it to a 401), records the event idempotently,
   * and — on a `succeeded` event for a known intent — fulfills it in one
   * transaction.
   *
   * Returns `{duplicate:true}` for a redelivery (200, no-op) and `{fulfilled:
   * true}` for the delivery that actually processed.
   */
  async handleWebhook(
    provider: PaymentProviderKind,
    rawBody: Buffer | string,
    headers: WebhookHeaders,
  ): Promise<HandleWebhookResult> {
    // Verify the signature. A bad/forged/absent signature throws here; we let it
    // propagate so the HTTP layer returns 401 (never a 200). The body is NOT
    // recorded for an unverified event.
    const event = await this.deps.providers.get(provider).verifyWebhook(rawBody, headers);

    // Resolve the intent this event refers to (may be undefined for an event we
    // never created an intent for — still recorded, but not fulfilled).
    const intent = await getIntentByProviderRef(this.deps.db, provider, event.providerRef);

    // Record the verified event idempotently. A redelivery conflicts on
    // `unique(provider, provider_event_id)` and is a no-op.
    const recorded = await insertEventIfNew(this.deps.db, {
      paymentIntentId: intent?.id ?? null,
      provider,
      providerEventId: event.eventId,
      type: event.type,
      rawPayload: this.toRawPayload(event),
      signatureOk: true,
    });

    if (!recorded.inserted || recorded.row === undefined) {
      return { duplicate: true };
    }

    const eventRow = recorded.row;

    // Only a `succeeded` event against a known intent triggers fulfillment.
    if (intent === undefined || event.status !== 'succeeded') {
      return { fulfilled: true };
    }

    await this.fulfill(intent, eventRow.id);
    return { fulfilled: true };
  }

  /**
   * Fulfill a succeeded intent in ONE transaction: for a `topup`, credit the
   * account ledger by the frozen `creditAmount`; for any purpose, transition the
   * intent to `succeeded` and mark the event processed. Because this is a single
   * transaction guarded upstream by the `unique(provider, event_id)` insert, a
   * provider retry can never double-credit.
   */
  private async fulfill(
    intent: NonNullable<Awaited<ReturnType<typeof getIntentByProviderRef>>>,
    eventId: string,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      if (intent.purpose === 'topup') {
        if (intent.creditAmount === null) {
          throw engineError('internal_error', 'topup intent missing credit_amount');
        }
        const account = await getAccountByTenant(tx, intent.tenantId);
        if (account === undefined) {
          throw engineError('internal_error', `no account for tenant ${intent.tenantId}`);
        }
        await topUp(tx, account.id, intent.tenantId, intent.creditAmount);
      }
      // `order` / `subscription`: the intent transition below records payment;
      // a future fulfillment hook (mark the order paid) lands here.

      await setIntentStatus(tx, intent.id, 'succeeded');
      await markEventProcessed(tx, eventId);
    });
  }

  /** Carry the normalized verified event as the audited `raw_payload`. */
  private toRawPayload(event: VerifiedEvent): Record<string, unknown> {
    return {
      eventId: event.eventId,
      type: event.type,
      providerRef: event.providerRef,
      status: event.status,
    };
  }
}

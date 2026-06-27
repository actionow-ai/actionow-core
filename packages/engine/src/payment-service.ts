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
   * µUSD granted per one currency *minor unit*. Under the µUSD doctrine (1
   * credit = $1 = 1_000_000 µUSD) this is 10_000 (1 USD cent buys 10_000 µUSD,
   * so `$1 = 100 cents × 10_000 = 1_000_000 µUSD`). Fixed at intent creation and
   * persisted on the intent so a later rate change never re-prices an in-flight
   * topup. May be a thunk so the api can resolve the LIVE `CREDIT_RATE` dynamic
   * setting (动态配置) per-intent instead of freezing the boot-time value.
   */
  creditRate: bigint | (() => bigint | Promise<bigint>);
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
 *  - event-recording AND fulfillment (record the event + credit the ledger +
 *    transition the intent + mark it processed) run in ONE transaction, so a
 *    crash/abort mid-fulfillment rolls the event row back too — the redelivery
 *    re-runs cleanly instead of being mis-classified as a duplicate (which would
 *    silently lose the paid topup).
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

    const creditRate =
      typeof this.deps.creditRate === 'function'
        ? await this.deps.creditRate()
        : this.deps.creditRate;
    const creditAmount = input.purpose === 'topup' ? input.amountMinor * creditRate : null;

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
    // recorded for an unverified event. Verification does no DB work, so it stays
    // OUTSIDE the transaction below (don't hold a tx open across provider I/O).
    const event = await this.deps.providers.get(provider).verifyWebhook(rawBody, headers);

    // Record the event AND fulfill in ONE transaction (see class doc): the
    // `unique(provider, provider_event_id)` insert is the exactly-once anchor and
    // must commit atomically with the credit/transition. A redelivery conflicts
    // and no-ops; a failed fulfillment rolls the event row back so the provider's
    // retry re-runs cleanly instead of being lost as a duplicate.
    return this.deps.db.transaction(async (tx) => {
      // Resolve the intent this event refers to (may be undefined for an event we
      // never created an intent for — still recorded, but not fulfilled).
      const intent = await getIntentByProviderRef(tx, provider, event.providerRef);

      const recorded = await insertEventIfNew(tx, {
        paymentIntentId: intent?.id ?? null,
        // Scope snapshots (记录系统 M-2b): copied from the resolved intent so the
        // audit event stays scopable after the intent is pruned (FK SET NULL).
        tenantId: intent?.tenantId ?? null,
        subjectId: intent?.subjectId ?? null,
        provider,
        providerEventId: event.eventId,
        type: event.type,
        rawPayload: this.toRawPayload(event),
        signatureOk: true,
      });

      if (!recorded.inserted || recorded.row === undefined) {
        return { duplicate: true };
      }

      // Only a `succeeded` event against a known intent triggers fulfillment.
      if (intent !== undefined && event.status === 'succeeded') {
        await this.fulfill(tx, intent, recorded.row.id);
      }
      return { fulfilled: true };
    });
  }

  /**
   * Fulfill a succeeded intent within the caller's transaction `tx`: for a
   * `topup`, credit the account ledger by the frozen `creditAmount`; for any
   * purpose, transition the intent to `succeeded` and mark the event processed.
   * Runs inside the same transaction as the event-record insert (see
   * {@link handleWebhook}), so a throw here rolls the whole unit back — and the
   * `unique(provider, event_id)` insert guarding that unit means a provider retry
   * can never double-credit.
   */
  private async fulfill(
    tx: DbOrTx,
    intent: NonNullable<Awaited<ReturnType<typeof getIntentByProviderRef>>>,
    eventId: string,
  ): Promise<void> {
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

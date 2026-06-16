import type { CreateIntentInput, IntentResult, VerifiedEvent } from '@actionow/contracts';
import Stripe from 'stripe';

import type { PaymentProvider, WebhookHeaders } from './types.js';
import {
  InvalidInputError,
  rawBodyToString,
  readHeader,
  SignatureVerificationError,
} from './types.js';

/** Config for the real Stripe provider. Both fields are secrets — never logged. */
export interface StripeProviderConfig {
  secretKey: string;
  webhookSecret: string;
  /**
   * Hosted Checkout `success_url`/`cancel_url`. Stripe requires a `success_url`;
   * a `{CHECKOUT_SESSION_ID}` template is appended so the redirect lands on a
   * status page. Fulfillment never happens on the redirect — only the webhook.
   */
  successUrl?: string;
  cancelUrl?: string;
}

const DEFAULT_SUCCESS_URL =
  'https://actionow.invalid/payments/success?session={CHECKOUT_SESSION_ID}';
const DEFAULT_CANCEL_URL = 'https://actionow.invalid/payments/cancel';

/**
 * The real, fully-working reference provider. Uses Stripe Checkout Sessions for
 * `createIntent` and `constructEvent`-verified webhooks for `verifyWebhook`.
 */
export function createStripeProvider(config: StripeProviderConfig): PaymentProvider {
  const stripe = new Stripe(config.secretKey);
  const successUrl = config.successUrl ?? DEFAULT_SUCCESS_URL;
  const cancelUrl = config.cancelUrl ?? DEFAULT_CANCEL_URL;

  return {
    kind: 'stripe',

    async createIntent(input: CreateIntentInput): Promise<IntentResult> {
      // Stripe expects a non-negative integer amount in the currency's minor
      // unit. Our domain carries it as a bigint; Stripe's typings want a number.
      // Amounts beyond MAX_SAFE_INTEGER are not real payment amounts — reject
      // rather than silently lose precision.
      if (input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new InvalidInputError('amount exceeds the maximum supported value');
      }
      const unitAmount = Number(input.amountMinor);

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: unitAmount,
                product_data: { name: `actionow ${input.purpose}` },
              },
            },
          ],
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: input.targetRef ?? input.tenantId,
          metadata: {
            tenant_id: input.tenantId,
            purpose: input.purpose,
            ...(input.targetRef ? { target_ref: input.targetRef } : {}),
          },
        },
        // An idempotency key makes a retried create return the same session
        // instead of opening a duplicate one.
        {
          idempotencyKey: `intent:${input.tenantId}:${input.purpose}:${input.currency}:${input.amountMinor.toString()}`,
        },
      );

      const result: IntentResult = { providerRef: session.id };
      if (session.url) result.redirectUrl = session.url;
      return result;
    },

    async verifyWebhook(rawBody: Buffer | string, headers: WebhookHeaders): Promise<VerifiedEvent> {
      const signature = readHeader(headers, 'stripe-signature');
      if (!signature) {
        throw new SignatureVerificationError('missing stripe-signature header');
      }

      let event: Stripe.Event;
      try {
        // constructEventAsync verifies the HMAC over the *raw* bytes; a bad or
        // forged signature (or a tampered body) throws.
        event = await stripe.webhooks.constructEventAsync(
          rawBodyToString(rawBody),
          signature,
          config.webhookSecret,
        );
      } catch {
        // Never echo the signature or the underlying Stripe error detail.
        throw new SignatureVerificationError();
      }

      return mapStripeEvent(event);
    },
  };
}

/** Maps a verified Stripe event to a normalized {@link VerifiedEvent}. */
function mapStripeEvent(event: Stripe.Event): VerifiedEvent {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    return {
      eventId: event.id,
      type: event.type,
      providerRef: session.id,
      status: 'succeeded',
    };
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    // The intent links back to its Checkout Session via metadata we set on
    // create; fall back to the payment-intent id when absent. `metadata` is
    // typed non-null but webhook JSON is untrusted, so narrow defensively.
    const metadata: unknown = intent.metadata;
    const refFromMeta =
      typeof metadata === 'object' && metadata !== null
        ? (metadata as Record<string, unknown>).provider_ref
        : undefined;
    const providerRef = typeof refFromMeta === 'string' ? refFromMeta : intent.id;
    return {
      eventId: event.id,
      type: event.type,
      providerRef,
      status: 'succeeded',
    };
  }

  // Any other verified event type is acknowledged but carries no fulfillment.
  // We surface it with a neutral `pending` status and the event id as the ref
  // so the caller can record it without attempting to match an intent.
  return {
    eventId: event.id,
    type: event.type,
    providerRef: event.id,
    status: 'pending',
  };
}

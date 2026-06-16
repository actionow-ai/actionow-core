import { z } from 'zod';

/**
 * The payment providers Actionow drives through the `PaymentProvider`
 * abstraction (implemented in `@actionow/payments`). `stripe` is the
 * fully-working reference (Checkout Sessions + `constructEvent` webhook); the
 * other three are creds-gated stubs whose verify/sign helpers are wired but
 * inert until their credentials are configured.
 */
export const PAYMENT_PROVIDERS = ['stripe', 'alipay', 'wechat', 'crypto'] as const;
export type PaymentProviderKind = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

/** What a payment is *for*. Drives fulfillment (topup → credit ledger, etc.). */
export const PAYMENT_PURPOSES = ['topup', 'order', 'subscription'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];
export const paymentPurposeSchema = z.enum(PAYMENT_PURPOSES);

/** Lifecycle of a `payment_intent`. */
export const PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * The input to create a payment intent. `amountMinor` is an integer count of
 * the currency's minor unit (e.g. cents) carried as a `bigint` so money never
 * touches a float. `currency` is an ISO-4217 code (provider-specific casing is
 * normalized by each provider). `targetRef` links the intent to a domain object
 * (e.g. an order id) for non-topup purposes.
 */
export const createIntentInputSchema = z.object({
  tenantId: z.string().uuid(),
  provider: paymentProviderSchema,
  purpose: paymentPurposeSchema,
  amountMinor: z.bigint().positive(),
  currency: z.string().min(1),
  targetRef: z.string().min(1).optional(),
});
export type CreateIntentInput = z.infer<typeof createIntentInputSchema>;

/**
 * What a provider returns from `createIntent`. `providerRef` is the provider's
 * own handle for the intent (Stripe session id, Alipay/WeChat out_trade_no,
 * etc.) and is the join key webhooks resolve against. `redirectUrl` is a hosted
 * checkout/pay URL; `qr` is a code string (e.g. WeChat Native `code_url`).
 */
export interface IntentResult {
  providerRef: string;
  redirectUrl?: string;
  qr?: string;
}

/**
 * A signature-verified webhook event, normalized across providers. `eventId` is
 * the provider's idempotency key for the event (`payment_event.unique(provider,
 * provider_event_id)` is keyed on it); `providerRef` joins back to the intent;
 * `status` is the lifecycle transition the event implies.
 */
export interface VerifiedEvent {
  eventId: string;
  type: string;
  providerRef: string;
  status: PaymentStatus;
}

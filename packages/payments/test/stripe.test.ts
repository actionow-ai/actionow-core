import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { createStripeProvider } from '../src/stripe.js';
import { SignatureVerificationError } from '../src/types.js';

const SECRET_KEY = 'sk_test_dummy_key_for_unit_tests';
const WEBHOOK_SECRET = 'whsec_dummy_secret_for_unit_tests';

/**
 * Builds a `checkout.session.completed` event body and a matching valid
 * `Stripe-Signature` header the way Stripe's own SDK does in tests — so the
 * provider's `constructEvent` verifies it without any live network.
 */
function signedEvent(
  type: 'checkout.session.completed' | 'payment_intent.succeeded',
  object: Record<string, unknown>,
): { body: string; header: string } {
  const payload = JSON.stringify({
    id: 'evt_test_123',
    object: 'event',
    type,
    data: { object },
  });
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { body: payload, header };
}

describe('stripe provider verifyWebhook', () => {
  const provider = createStripeProvider({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
  });

  it('parses a correctly-signed checkout.session.completed event', async () => {
    const { body, header } = signedEvent('checkout.session.completed', {
      id: 'cs_test_abc',
      object: 'checkout.session',
    });

    const verified = await provider.verifyWebhook(body, { 'stripe-signature': header });

    expect(verified.eventId).toBe('evt_test_123');
    expect(verified.type).toBe('checkout.session.completed');
    expect(verified.providerRef).toBe('cs_test_abc');
    expect(verified.status).toBe('succeeded');
  });

  it('parses a correctly-signed payment_intent.succeeded event (ref from metadata)', async () => {
    const { body, header } = signedEvent('payment_intent.succeeded', {
      id: 'pi_test_xyz',
      object: 'payment_intent',
      metadata: { provider_ref: 'cs_test_from_meta' },
    });

    const verified = await provider.verifyWebhook(body, { 'stripe-signature': header });

    expect(verified.type).toBe('payment_intent.succeeded');
    expect(verified.providerRef).toBe('cs_test_from_meta');
    expect(verified.status).toBe('succeeded');
  });

  it('falls back to the payment_intent id when no provider_ref metadata is present', async () => {
    const { body, header } = signedEvent('payment_intent.succeeded', {
      id: 'pi_test_noref',
      object: 'payment_intent',
    });

    const verified = await provider.verifyWebhook(body, { 'stripe-signature': header });

    expect(verified.providerRef).toBe('pi_test_noref');
  });

  it('throws on a bad signature', async () => {
    const { body } = signedEvent('checkout.session.completed', {
      id: 'cs_test_abc',
      object: 'checkout.session',
    });

    await expect(
      provider.verifyWebhook(body, { 'stripe-signature': 't=1,v1=deadbeef' }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('throws when the signature header is absent', async () => {
    const { body } = signedEvent('checkout.session.completed', {
      id: 'cs_test_abc',
      object: 'checkout.session',
    });

    await expect(provider.verifyWebhook(body, {})).rejects.toBeInstanceOf(
      SignatureVerificationError,
    );
  });

  it('throws when the body is tampered after signing', async () => {
    const { body, header } = signedEvent('checkout.session.completed', {
      id: 'cs_test_abc',
      object: 'checkout.session',
    });
    const tampered = body.replace('cs_test_abc', 'cs_test_evil');

    await expect(
      provider.verifyWebhook(tampered, { 'stripe-signature': header }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });
});

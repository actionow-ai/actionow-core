import { describe, expect, it } from 'vitest';

import {
  createIntentInputSchema,
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  paymentProviderSchema,
  paymentPurposeSchema,
  paymentStatusSchema,
} from '../src/payment.js';

describe('payment contracts', () => {
  it('lists the four supported provider kinds', () => {
    expect(PAYMENT_PROVIDERS).toEqual(['stripe', 'alipay', 'wechat', 'crypto']);
  });

  it('lists the three purposes', () => {
    expect(PAYMENT_PURPOSES).toEqual(['topup', 'order', 'subscription']);
  });

  it('lists the six statuses', () => {
    expect(PAYMENT_STATUSES).toEqual([
      'created',
      'pending',
      'succeeded',
      'failed',
      'expired',
      'refunded',
    ]);
  });

  it('provider/purpose/status schemas accept valid values and reject unknowns', () => {
    expect(paymentProviderSchema.parse('stripe')).toBe('stripe');
    expect(paymentPurposeSchema.parse('topup')).toBe('topup');
    expect(paymentStatusSchema.parse('succeeded')).toBe('succeeded');
    expect(() => paymentProviderSchema.parse('paypal')).toThrow();
    expect(() => paymentPurposeSchema.parse('refund')).toThrow();
    expect(() => paymentStatusSchema.parse('settled')).toThrow();
  });

  it('createIntentInputSchema accepts a topup intent with bigint minor units', () => {
    const input = createIntentInputSchema.parse({
      tenantId: '11111111-1111-1111-1111-111111111111',
      provider: 'stripe',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
    });
    expect(input.amountMinor).toBe(1000n);
    expect(input.currency).toBe('usd');
    expect(input.targetRef).toBeUndefined();
  });

  it('createIntentInputSchema accepts an order intent with a targetRef', () => {
    const input = createIntentInputSchema.parse({
      tenantId: '11111111-1111-1111-1111-111111111111',
      provider: 'alipay',
      purpose: 'order',
      amountMinor: 5000n,
      currency: 'cny',
      targetRef: 'order_42',
    });
    expect(input.targetRef).toBe('order_42');
  });

  it('createIntentInputSchema rejects a non-positive amount', () => {
    expect(() =>
      createIntentInputSchema.parse({
        tenantId: '11111111-1111-1111-1111-111111111111',
        provider: 'stripe',
        purpose: 'topup',
        amountMinor: 0n,
        currency: 'usd',
      }),
    ).toThrow();
  });

  it('createIntentInputSchema rejects a fractional (non-bigint) amount', () => {
    expect(() =>
      createIntentInputSchema.parse({
        tenantId: '11111111-1111-1111-1111-111111111111',
        provider: 'stripe',
        purpose: 'topup',
        amountMinor: 10.5,
        currency: 'usd',
      }),
    ).toThrow();
  });
});

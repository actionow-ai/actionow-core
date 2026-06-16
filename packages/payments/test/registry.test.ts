import { describe, expect, it } from 'vitest';

import { createPaymentRegistry } from '../src/registry.js';
import { InvalidInputError } from '../src/types.js';

describe('createPaymentRegistry', () => {
  it('resolves a stripe provider when stripe creds are present', () => {
    const registry = createPaymentRegistry({
      stripe: { secretKey: 'sk_test', webhookSecret: 'whsec_test' },
    });
    const provider = registry.get('stripe');
    expect(provider.kind).toBe('stripe');
  });

  it('has() reports which providers are configured', () => {
    const registry = createPaymentRegistry({
      stripe: { secretKey: 'sk_test', webhookSecret: 'whsec_test' },
      crypto: { webhookSecret: 'cb_secret' },
    });
    expect(registry.has('stripe')).toBe(true);
    expect(registry.has('crypto')).toBe(true);
    expect(registry.has('alipay')).toBe(false);
    expect(registry.has('wechat')).toBe(false);
  });

  it('get() of an unconfigured provider throws invalid_input', () => {
    const registry = createPaymentRegistry({});
    expect(() => registry.get('alipay')).toThrow(InvalidInputError);
  });

  it('an unconfigured-creds provider is still registered but inert (creds-gated)', async () => {
    // alipay config present but missing the public key → the provider builds but
    // its operations return invalid_input.
    const registry = createPaymentRegistry({
      alipay: { appId: 'app', privateKey: 'pk' },
    });
    expect(registry.has('alipay')).toBe(true);
    await expect(registry.get('alipay').verifyWebhook('{}', {})).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('configuredKinds lists the registered provider kinds', () => {
    const registry = createPaymentRegistry({
      stripe: { secretKey: 'sk', webhookSecret: 'wh' },
      wechat: { appId: 'a', mchId: 'm', apiV3Key: 'k', publicKey: 'p', publicKeyId: 'id' },
    });
    expect([...registry.configuredKinds()].sort()).toEqual(['stripe', 'wechat']);
  });
});

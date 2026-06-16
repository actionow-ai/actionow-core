import type { PaymentProviderKind } from '@actionow/contracts';

import type { AlipayProviderConfig } from './alipay.js';
import { createAlipayProvider } from './alipay.js';
import type { CryptoProviderConfig } from './crypto.js';
import { createCryptoProvider } from './crypto.js';
import type { StripeProviderConfig } from './stripe.js';
import { createStripeProvider } from './stripe.js';
import type { PaymentProvider } from './types.js';
import { InvalidInputError } from './types.js';
import type { WechatProviderConfig } from './wechat.js';
import { createWechatProvider } from './wechat.js';

/**
 * Per-provider config. A provider is registered iff its config block is present.
 * Whether the block is *complete enough to operate* is the provider's own
 * concern (creds-gated stubs return `invalid_input` when partially configured),
 * so the registry only decides registration, not readiness.
 */
export interface PaymentRegistryConfig {
  stripe?: StripeProviderConfig;
  alipay?: AlipayProviderConfig;
  wechat?: WechatProviderConfig;
  crypto?: CryptoProviderConfig;
}

/** A resolved set of payment providers, keyed by kind. */
export interface PaymentRegistry {
  /** Returns the provider for `kind`, or throws `invalid_input` if unregistered. */
  get(kind: PaymentProviderKind): PaymentProvider;
  /** Whether a provider is registered for `kind`. */
  has(kind: PaymentProviderKind): boolean;
  /** The kinds that are registered. */
  configuredKinds(): PaymentProviderKind[];
}

/**
 * Builds a {@link PaymentRegistry} from whatever provider configs are present.
 * A provider block that is absent leaves that kind unregistered; `get` of an
 * unregistered kind throws `invalid_input` (the API maps that to a 400 / route
 * disabled) rather than crashing.
 */
export function createPaymentRegistry(config: PaymentRegistryConfig): PaymentRegistry {
  const providers = new Map<PaymentProviderKind, PaymentProvider>();

  if (config.stripe) providers.set('stripe', createStripeProvider(config.stripe));
  if (config.alipay) providers.set('alipay', createAlipayProvider(config.alipay));
  if (config.wechat) providers.set('wechat', createWechatProvider(config.wechat));
  if (config.crypto) providers.set('crypto', createCryptoProvider(config.crypto));

  return {
    get(kind: PaymentProviderKind): PaymentProvider {
      const provider = providers.get(kind);
      if (!provider) {
        throw new InvalidInputError(`payment provider '${kind}' is not configured`);
      }
      return provider;
    },
    has(kind: PaymentProviderKind): boolean {
      return providers.has(kind);
    },
    configuredKinds(): PaymentProviderKind[] {
      return [...providers.keys()];
    },
  };
}

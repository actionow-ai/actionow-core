import type { Database } from '@actionow/db';
import { PaymentService } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import type { PaymentRegistryConfig } from '@actionow/payments';
import { createPaymentRegistry } from '@actionow/payments';
import type { Provider } from '@nestjs/common';
import { Logger, Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { DB, ENV, PAYMENTS } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

/**
 * The engine {@link PaymentService}, built from whatever payment-provider creds
 * are present in env. A provider whose creds are unset is simply not registered;
 * its `/v1/payments` routes then return `invalid_input` (the API still boots).
 * The credit rate (µcredits per currency-minor-unit) is read from `CREDIT_RATE`
 * and frozen onto each topup intent at creation. Secrets/keys are never logged —
 * only which providers were configured.
 */
const paymentsProvider: Provider = {
  provide: PAYMENTS,
  inject: [DB, ENV, SettingsService],
  useFactory: (db: Database, env: AppEnv, settings: SettingsService): PaymentService => {
    const config = registryConfigFromEnv(env);
    const registry = createPaymentRegistry(config);
    const logger = new Logger('Payments');
    const kinds = registry.configuredKinds();
    logger.log(
      kinds.length === 0
        ? 'no payment providers configured — /v1/payments routes return invalid_input'
        : `payment providers configured: ${kinds.join(', ')}`,
    );
    return new PaymentService({
      db,
      providers: registry,
      // Resolve the LIVE CREDIT_RATE per intent (动态配置); still frozen onto the intent.
      creditRate: async () => BigInt(await settings.get('CREDIT_RATE')),
    });
  },
};

/**
 * Assemble a {@link PaymentRegistryConfig} from env. Each provider block is only
 * included when its core creds are present, so a partially-/un-configured
 * provider is left unregistered (rather than half-built). The Stripe block also
 * carries the optional success/cancel redirect URLs.
 */
function registryConfigFromEnv(env: AppEnv): PaymentRegistryConfig {
  const config: PaymentRegistryConfig = {};

  if (env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_WEBHOOK_SECRET !== undefined) {
    config.stripe = {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      ...(env.STRIPE_SUCCESS_URL !== undefined ? { successUrl: env.STRIPE_SUCCESS_URL } : {}),
      ...(env.STRIPE_CANCEL_URL !== undefined ? { cancelUrl: env.STRIPE_CANCEL_URL } : {}),
    };
  }

  if (
    env.ALIPAY_APP_ID !== undefined &&
    env.ALIPAY_PRIVATE_KEY !== undefined &&
    env.ALIPAY_PUBLIC_KEY !== undefined
  ) {
    config.alipay = {
      appId: env.ALIPAY_APP_ID,
      privateKey: env.ALIPAY_PRIVATE_KEY,
      alipayPublicKey: env.ALIPAY_PUBLIC_KEY,
      ...(env.ALIPAY_GATEWAY !== undefined ? { gateway: env.ALIPAY_GATEWAY } : {}),
    };
  }

  if (
    env.WECHAT_APP_ID !== undefined &&
    env.WECHAT_MCH_ID !== undefined &&
    env.WECHAT_API_V3_KEY !== undefined &&
    env.WECHAT_PUBLIC_KEY !== undefined &&
    env.WECHAT_PUBLIC_KEY_ID !== undefined
  ) {
    config.wechat = {
      appId: env.WECHAT_APP_ID,
      mchId: env.WECHAT_MCH_ID,
      apiV3Key: env.WECHAT_API_V3_KEY,
      publicKey: env.WECHAT_PUBLIC_KEY,
      publicKeyId: env.WECHAT_PUBLIC_KEY_ID,
    };
  }

  if (env.CRYPTO_WEBHOOK_SECRET !== undefined) {
    config.crypto = { webhookSecret: env.CRYPTO_WEBHOOK_SECRET };
  }

  return config;
}

/**
 * Wires `/v1/payments` ({@link PaymentsController}) and `/admin/payments`
 * ({@link AdminPaymentsController}) over the engine {@link PaymentService} (token
 * {@link PAYMENTS}). The webhook route intentionally has NO ApiKeyGuard — the
 * provider signature over the raw body is the auth. The admin list route reuses
 * the {@link AdminModule}'s `AdminGuard` (imported below). `DB`/`ENV` come from
 * the global {@link DbModule}.
 */
@Module({
  imports: [AdminModule],
  controllers: [PaymentsController, AdminPaymentsController],
  providers: [paymentsProvider, PaymentsService, AuthService, ApiKeyGuard],
  exports: [PAYMENTS],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class PaymentsModule {}

import type {
  CreateIntentInput,
  IntentResult,
  PaymentStatus,
  VerifiedEvent,
} from '@actionow/contracts';
import { AlipaySdk } from 'alipay-sdk';

import type { PaymentProvider, WebhookHeaders } from './types.js';
import { InvalidInputError, rawBodyToString, SignatureVerificationError } from './types.js';

/**
 * Config for the Alipay provider. `appId` + `privateKey` + `alipayPublicKey`
 * (RSA2) are required to operate; any missing → a creds-gated stub returning
 * `invalid_input`. The private key + public key are secrets — never logged.
 */
export interface AlipayProviderConfig {
  appId?: string;
  /** App RSA private key (PKCS8/PKCS1 PEM). */
  privateKey?: string;
  /** Alipay platform public key (PEM) used to verify async-notify signatures. */
  alipayPublicKey?: string;
  /** Gateway override (defaults to the SDK's production gateway). */
  gateway?: string;
}

interface ResolvedAlipayConfig {
  sdk: AlipaySdk;
}

function resolveConfig(config: AlipayProviderConfig): ResolvedAlipayConfig | undefined {
  const { appId, privateKey, alipayPublicKey, gateway } = config;
  if (!appId || !privateKey || !alipayPublicKey) return undefined;
  const sdk = new AlipaySdk({
    appId,
    privateKey,
    alipayPublicKey,
    signType: 'RSA2',
    ...(gateway ? { gateway } : {}),
  });
  return { sdk };
}

/**
 * Parses an Alipay async-notify body into a flat string→string form. The body
 * may arrive as a URL-encoded form (the real gateway) or a JSON object (callers
 * that pre-parsed it). Non-string values are dropped — `checkNotifySignV2`
 * signs over string fields only.
 */
function parseNotifyForm(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  // URL-encoded form fallback.
  const out: Record<string, string> = {};
  const params = new URLSearchParams(trimmed);
  for (const [k, v] of params.entries()) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

function statusForTradeStatus(tradeStatus: string | undefined): PaymentStatus {
  switch (tradeStatus) {
    case 'TRADE_SUCCESS':
    case 'TRADE_FINISHED':
      return 'succeeded';
    case 'TRADE_CLOSED':
      return 'failed';
    case 'WAIT_BUYER_PAY':
      return 'pending';
    default:
      return 'pending';
  }
}

export function createAlipayProvider(config: AlipayProviderConfig): PaymentProvider {
  const resolved = resolveConfig(config);

  return {
    kind: 'alipay',

    createIntent(_input: CreateIntentInput): Promise<IntentResult> {
      void _input;
      if (!resolved) {
        return Promise.reject(new InvalidInputError('alipay provider is not configured'));
      }
      // Stub: a real page-pay builds a `trade.page.pay` redirect URL via
      // `sdk.pageExecute('alipay.trade.page.pay', ...)`. Not wired this phase.
      return Promise.reject(new InvalidInputError('alipay createIntent is not implemented'));
    },

    verifyWebhook(rawBody: Buffer | string, _headers: WebhookHeaders): Promise<VerifiedEvent> {
      void _headers;
      if (!resolved) {
        return Promise.reject(new InvalidInputError('alipay provider is not configured'));
      }

      const form = parseNotifyForm(rawBodyToString(rawBody));
      if (!form) {
        return Promise.reject(new InvalidInputError('malformed alipay notify body'));
      }
      if (!form.sign) {
        return Promise.reject(new SignatureVerificationError('missing alipay sign'));
      }

      // checkNotifySignV2 RSA2-verifies the sorted `k=v&...` canonical string
      // (raw values, `sign`/`sign_type` handling per Alipay) against the
      // configured platform public key. Returns false on mismatch — we never
      // echo the signature.
      let ok: boolean;
      try {
        ok = resolved.sdk.checkNotifySignV2(form);
      } catch {
        ok = false;
      }
      if (!ok) {
        return Promise.reject(new SignatureVerificationError());
      }

      const tradeStatus = form.trade_status;
      const eventId = form.notify_id ?? form.trade_no ?? form.out_trade_no ?? 'alipay_notify';
      return Promise.resolve({
        eventId,
        type: form.notify_type ?? 'trade_status_sync',
        providerRef: form.out_trade_no ?? form.trade_no ?? eventId,
        status: statusForTradeStatus(tradeStatus),
      });
    },
  };
}

import { createDecipheriv, createVerify } from 'node:crypto';

import type {
  CreateIntentInput,
  IntentResult,
  PaymentStatus,
  VerifiedEvent,
} from '@actionow/contracts';

import type { PaymentProvider, WebhookHeaders } from './types.js';
import {
  InvalidInputError,
  rawBodyToString,
  readHeader,
  SignatureVerificationError,
} from './types.js';

/**
 * Config for the WeChat Pay APIv3 provider. All fields are required to operate;
 * any missing → the provider is a creds-gated stub returning `invalid_input`.
 *
 * `publicKey`/`publicKeyId` select WeChat's newer *public-key* verification
 * mode: when an inbound `Wechatpay-Serial` equals `publicKeyId` (the
 * `PUB_KEY_ID_*` form) the platform public key is used to verify. A real
 * deployment would also carry a platform-certificate map for the legacy
 * (certificate-serial) branch; that lookup is out of scope for this phase and
 * an unknown serial is rejected. Secrets (`apiV3Key`) are never logged.
 */
export interface WechatProviderConfig {
  appId?: string;
  mchId?: string;
  /** 32-byte APIv3 key used to AES-256-GCM-decrypt the `resource`. */
  apiV3Key?: string;
  /** Platform public key (PEM) for the `PUB_KEY_ID_*` verification branch. */
  publicKey?: string;
  /** The `PUB_KEY_ID_*` serial that selects the public-key branch. */
  publicKeyId?: string;
}

interface ResolvedWechatConfig {
  appId: string;
  mchId: string;
  apiV3Key: string;
  publicKey: string;
  publicKeyId: string;
}

function resolveConfig(config: WechatProviderConfig): ResolvedWechatConfig | undefined {
  const { appId, mchId, apiV3Key, publicKey, publicKeyId } = config;
  if (!appId || !mchId || !apiV3Key || !publicKey || !publicKeyId) return undefined;
  return { appId, mchId, apiV3Key, publicKey, publicKeyId };
}

/** The encrypted `resource` envelope inside an APIv3 notification. */
interface EncryptedResource {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  associatedData?: string;
}

interface WechatNotification {
  id: string;
  eventType: string;
  resource: EncryptedResource;
}

/** Narrows untrusted notification JSON (no `any`). */
function parseNotification(raw: string): WechatNotification | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const { id, event_type: eventType, resource } = obj;
  if (typeof id !== 'string' || typeof eventType !== 'string') return undefined;
  if (typeof resource !== 'object' || resource === null) return undefined;
  const res = resource as Record<string, unknown>;
  if (
    typeof res.algorithm !== 'string' ||
    typeof res.ciphertext !== 'string' ||
    typeof res.nonce !== 'string'
  ) {
    return undefined;
  }
  const associatedData = typeof res.associated_data === 'string' ? res.associated_data : undefined;
  return {
    id,
    eventType,
    resource:
      associatedData === undefined
        ? { algorithm: res.algorithm, ciphertext: res.ciphertext, nonce: res.nonce }
        : {
            algorithm: res.algorithm,
            ciphertext: res.ciphertext,
            nonce: res.nonce,
            associatedData,
          },
  };
}

/**
 * AES-256-GCM-decrypts a base64 `ciphertext` (with the 16-byte auth tag
 * appended, as WeChat sends it) using the APIv3 key, 12-byte nonce, and AAD.
 */
function decryptResource(resource: EncryptedResource, apiV3Key: string): string {
  const raw = Buffer.from(resource.ciphertext, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(resource.nonce, 'utf8'),
  );
  if (resource.associatedData !== undefined) {
    decipher.setAAD(Buffer.from(resource.associatedData, 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Reads `out_trade_no` + `trade_state` from a decrypted transaction resource. */
function readTransaction(plaintext: string): { outTradeNo?: string; tradeState?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const result: { outTradeNo?: string; tradeState?: string } = {};
  if (typeof obj.out_trade_no === 'string') result.outTradeNo = obj.out_trade_no;
  if (typeof obj.trade_state === 'string') result.tradeState = obj.trade_state;
  return result;
}

function statusForWechat(eventType: string, tradeState: string | undefined): PaymentStatus {
  if (eventType === 'TRANSACTION.SUCCESS' || tradeState === 'SUCCESS') return 'succeeded';
  if (tradeState === 'CLOSED' || tradeState === 'REVOKED' || tradeState === 'PAYERROR') {
    return 'failed';
  }
  return 'pending';
}

export function createWechatProvider(config: WechatProviderConfig): PaymentProvider {
  const resolved = resolveConfig(config);

  return {
    kind: 'wechat',

    createIntent(_input: CreateIntentInput): Promise<IntentResult> {
      void _input;
      if (!resolved) {
        return Promise.reject(new InvalidInputError('wechat provider is not configured'));
      }
      // Stub: a real Native order calls /v3/pay/transactions/native and returns
      // `code_url` (rendered as a QR). Not wired in this phase.
      return Promise.reject(new InvalidInputError('wechat createIntent is not implemented'));
    },

    verifyWebhook(rawBody: Buffer | string, headers: WebhookHeaders): Promise<VerifiedEvent> {
      if (!resolved) {
        return Promise.reject(new InvalidInputError('wechat provider is not configured'));
      }

      const serial = readHeader(headers, 'wechatpay-serial');
      const timestamp = readHeader(headers, 'wechatpay-timestamp');
      const nonce = readHeader(headers, 'wechatpay-nonce');
      const signature = readHeader(headers, 'wechatpay-signature');
      if (!serial || !timestamp || !nonce || !signature) {
        return Promise.reject(new SignatureVerificationError('missing Wechatpay-* headers'));
      }

      // Branch on the serial: the `PUB_KEY_ID_*` form selects the platform
      // public key; any other serial would require a platform-certificate map
      // (out of scope this phase) and is rejected rather than trusted.
      if (serial !== resolved.publicKeyId) {
        return Promise.reject(
          new SignatureVerificationError('unknown Wechatpay-Serial (no matching key)'),
        );
      }

      const body = rawBodyToString(rawBody);
      // WeChat signs `timestamp\nnonce\nbody\n` with SHA256-RSA; verify with the
      // platform public key.
      const message = `${timestamp}\n${nonce}\n${body}\n`;
      let ok: boolean;
      try {
        ok = createVerify('RSA-SHA256')
          .update(message, 'utf8')
          .verify(resolved.publicKey, signature, 'base64');
      } catch {
        ok = false;
      }
      if (!ok) {
        return Promise.reject(new SignatureVerificationError());
      }

      const notification = parseNotification(body);
      if (!notification) {
        return Promise.reject(new InvalidInputError('malformed wechat notification body'));
      }

      let plaintext: string;
      try {
        plaintext = decryptResource(notification.resource, resolved.apiV3Key);
      } catch {
        // A decrypt failure means the body did not match the configured APIv3
        // key — treat as a verification failure, never echo the key.
        return Promise.reject(new SignatureVerificationError('resource decryption failed'));
      }

      const { outTradeNo, tradeState } = readTransaction(plaintext);
      return Promise.resolve({
        eventId: notification.id,
        type: notification.eventType,
        providerRef: outTradeNo ?? notification.id,
        status: statusForWechat(notification.eventType, tradeState),
      });
    },
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

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
 * Config for the Coinbase Commerce ("crypto") provider. `webhookSecret` is the
 * shared secret from the Commerce dashboard; absent → the provider is a no-op
 * stub that returns `invalid_input`. Never logged.
 */
export interface CryptoProviderConfig {
  webhookSecret?: string;
}

/** Minimal shape of a Coinbase Commerce webhook envelope we read after verify. */
interface CommerceEvent {
  id: string;
  type: string;
  code?: string;
}

/**
 * Narrows untrusted webhook JSON to a {@link CommerceEvent}. Coinbase wraps the
 * event in `{ event: { id, type, data: { code } } }`. Returns `undefined` if the
 * shape is not as expected (no `any`, no unchecked indexing).
 */
function parseCommerceEvent(raw: string): CommerceEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const event: unknown = (parsed as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) return undefined;
  const e = event as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.type !== 'string') return undefined;
  let code: string | undefined;
  const data: unknown = e.data;
  if (typeof data === 'object' && data !== null) {
    const c: unknown = (data as Record<string, unknown>).code;
    if (typeof c === 'string') code = c;
  }
  return code === undefined ? { id: e.id, type: e.type } : { id: e.id, type: e.type, code };
}

/** Maps a Coinbase Commerce event type to a payment status. */
function statusForCommerceType(type: string): PaymentStatus {
  switch (type) {
    case 'charge:confirmed':
      return 'succeeded';
    case 'charge:failed':
      return 'failed';
    case 'charge:delayed':
    case 'charge:pending':
    case 'charge:created':
      return 'pending';
    default:
      return 'pending';
  }
}

export function createCryptoProvider(config: CryptoProviderConfig): PaymentProvider {
  const { webhookSecret } = config;

  return {
    kind: 'crypto',

    createIntent(_input: CreateIntentInput): Promise<IntentResult> {
      // Stub: Commerce charge creation requires an API key (not wired in this
      // phase). Until configured, the route fails fast with invalid_input.
      void _input;
      return Promise.reject(
        new InvalidInputError('crypto (Coinbase Commerce) provider is not configured'),
      );
    },

    verifyWebhook(rawBody: Buffer | string, headers: WebhookHeaders): Promise<VerifiedEvent> {
      if (!webhookSecret) {
        return Promise.reject(
          new InvalidInputError('crypto (Coinbase Commerce) provider is not configured'),
        );
      }

      const signature = readHeader(headers, 'x-cc-webhook-signature');
      if (!signature) {
        return Promise.reject(new SignatureVerificationError('missing X-CC-Webhook-Signature'));
      }

      const body = rawBodyToString(rawBody);
      // Coinbase signs the *raw* body with HMAC-SHA256(secret) → hex.
      const expected = createHmac('sha256', webhookSecret).update(body, 'utf8').digest('hex');

      // Constant-time compare; mismatched lengths short-circuit (timingSafeEqual
      // throws on unequal-length buffers).
      const provided = Buffer.from(signature, 'utf8');
      const computed = Buffer.from(expected, 'utf8');
      if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
        return Promise.reject(new SignatureVerificationError());
      }

      const event = parseCommerceEvent(body);
      if (!event) {
        return Promise.reject(new InvalidInputError('malformed Coinbase Commerce webhook body'));
      }

      return Promise.resolve({
        eventId: event.id,
        type: event.type,
        // The Commerce charge `code` is the provider reference we join on.
        providerRef: event.code ?? event.id,
        status: statusForCommerceType(event.type),
      });
    },
  };
}

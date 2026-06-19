import type {
  CreateIntentInput,
  IntentResult,
  PaymentProviderKind,
  VerifiedEvent,
} from '@actionow/contracts';

/**
 * HTTP-style headers as delivered to a webhook handler. A header may be absent,
 * a single string, or (for set-cookie-like duplicates) an array. Providers read
 * only the few signature headers they care about and narrow them defensively.
 */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * A single payment rail. `stripe` is the real reference; `alipay`/`wechat`/
 * `crypto` are creds-gated stubs whose verify algorithms are wired but throw
 * {@link InvalidInputError} (`invalid_input`) until their credentials are set.
 *
 * `verifyWebhook` MUST throw on a bad/forged/absent signature (never return a
 * "failed" event for an unverified body) — callers treat a thrown error as a
 * 401. It receives the *raw* request bytes because re-serializing parsed JSON
 * would not byte-match the provider's signature.
 */
export interface PaymentProvider {
  readonly kind: PaymentProviderKind;
  createIntent(input: CreateIntentInput): Promise<IntentResult>;
  verifyWebhook(rawBody: Buffer | string, headers: WebhookHeaders): Promise<VerifiedEvent>;
}

/**
 * Thrown by a provider (or the registry) when a required operation cannot run
 * because the provider is not configured (creds unset) or the request is
 * malformed. Carries the stable `invalid_input` code so the API layer can map
 * it to a 400 without leaking provider internals. NEVER include a secret,
 * signature, or key in the message.
 */
export class InvalidInputError extends Error {
  readonly code = 'invalid_input' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * Thrown by `verifyWebhook` when a signature is missing, malformed, or does not
 * verify. The message is deliberately generic — it must never echo the received
 * signature, the expected signature, or any key material. Callers map this to a
 * 401.
 */
export class SignatureVerificationError extends Error {
  readonly code = 'signature_invalid' as const;
  constructor(message = 'webhook signature verification failed') {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Reads a single header value case-insensitively, collapsing an array to its
 * first element. Returns `undefined` when the header is absent or empty.
 */
export function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

/** Normalizes a raw webhook body to a UTF-8 string for string-based verifiers. */
export function rawBodyToString(rawBody: Buffer | string): string {
  return typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
}

/** Normalizes a raw webhook body to a Buffer for byte-based verifiers (HMAC). */
export function rawBodyToBuffer(rawBody: Buffer | string): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
}

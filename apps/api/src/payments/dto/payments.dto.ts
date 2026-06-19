import { paymentProviderSchema, paymentPurposeSchema } from '@actionow/contracts';
import { z } from 'zod';

/**
 * `POST /v1/payments/intents` body. `amount_minor` is an integer count of the
 * currency's minor unit (cents, fen, …), accepted as a JSON number and carried
 * downstream as a `bigint` — bounded to a safe integer here so it never loses
 * precision on the `BigInt()` conversion. `provider`/`purpose` are validated
 * against the contracts enums. `target_ref` links a non-topup intent to a
 * domain object (e.g. an order id).
 */
export const createIntentBodySchema = z.object({
  provider: paymentProviderSchema,
  purpose: paymentPurposeSchema,
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().min(1),
  target_ref: z.string().min(1).optional(),
});
export type CreateIntentBodyDto = z.infer<typeof createIntentBodySchema>;

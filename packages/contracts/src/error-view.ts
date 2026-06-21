import { z } from 'zod';

/**
 * The uniform error envelope EVERY control-/data-plane endpoint returns on a
 * non-2xx response (§4.7), serialized by the API's `UnifiedErrorFilter`:
 *
 * ```json
 * { "error": { "code": "rate_limited", "message": "slow down",
 *              "retryable": true, "retry_after_ms": 1000 } }
 * ```
 *
 * `code` is a unified error code (`invalid_input` | `unauthorized` |
 * `resource_not_found` | `rate_limited` | `insufficient_credits` | …); kept as a
 * `string` here for forward-compatibility. `retry_after_ms` is present only on
 * rate-limited / retryable upstream errors. Attaching this as the 4xx response
 * across the OpenAPI paths makes the SDK's `error` branch typed (instead of the
 * `never` that an undeclared error surface produces).
 */
export const errorViewSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    retry_after_ms: z.number().optional(),
  }),
});
export type ErrorView = z.infer<typeof errorViewSchema>;

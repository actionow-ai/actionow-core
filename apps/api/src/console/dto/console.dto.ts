import { paymentProviderSchema } from '@actionow/contracts';
import { z } from 'zod';

/**
 * Zod request schemas for the tenant-scoped console surface. Mirrors the admin
 * DTO style. The caller's tenant is NEVER part of any body — it is supplied by
 * the ConsoleGuard from the authenticated principal, so these schemas carry no
 * `tenantId`.
 */

/**
 * `POST /console/api-keys` — mint a key for the caller's own tenant. No
 * `tenantId`: the guard scopes it.
 */
export const consoleCreateApiKeySchema = z.object({
  resourceAllowlist: z.array(z.string()).optional(),
  /** Per-(tenant,resource) requests-per-minute cap; omitted → default. */
  rateLimit: z.number().int().positive().optional(),
});
export type ConsoleCreateApiKeyDto = z.infer<typeof consoleCreateApiKeySchema>;

/**
 * `POST /console/payments/topup` — self-serve credit topup. `amount_minor` is an
 * integer count of the currency's minor unit (cents, fen, …), bounded to a safe
 * integer so the downstream `BigInt()` conversion never loses precision. The
 * purpose is always `topup` (hardcoded by the service), so it is not in the body.
 */
export const consoleCreateIntentSchema = z.object({
  provider: paymentProviderSchema,
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().min(1),
});
export type ConsoleCreateIntentDto = z.infer<typeof consoleCreateIntentSchema>;

/**
 * `GET /console/analytics/usage` — tenant-scoped usage rollups. Unlike the admin
 * schema there is NO `tenantId` (the guard supplies it) and no `tenant` groupBy
 * (a tenant only has itself); `from`/`to` are ISO 8601.
 */
export const consoleAnalyticsUsageSchema = z.object({
  groupBy: z.enum(['day', 'model', 'channel', 'api_key']),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ConsoleAnalyticsUsageDto = z.infer<typeof consoleAnalyticsUsageSchema>;

/**
 * `PATCH /console/settings` — self-serve change-password. The new password
 * mirrors the registration policy (8–256 chars); the current one is verified
 * server-side against the stored scrypt hash before the swap.
 */
export const consoleChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});
export type ConsoleChangePasswordDto = z.infer<typeof consoleChangePasswordSchema>;

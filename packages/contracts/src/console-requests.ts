import { z } from 'zod';

import { paymentProviderSchema } from './payment.js';

/**
 * Single source of truth for the tenant-scoped console surface **request bodies**
 * (self-serve api-key mint, topup intent, change-password). Same contract-first
 * pattern as the `*-views.ts` files, but for the write side: the backend console
 * DTO re-exports these schemas (so `ZodBody` validates against them) and the
 * frontend imports the inferred TYPE only (`import type`), so no zod ships to the
 * browser. These schemas flow into `openapi.json` → `@actionow/sdk` as request
 * bodies.
 *
 * The caller's tenant is NEVER part of any body — the ConsoleGuard supplies it
 * from the authenticated principal, so these schemas carry no `tenantId`.
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
export type ConsoleCreateApiKeyBody = z.infer<typeof consoleCreateApiKeySchema>;

/**
 * `POST /console/payments/intents` — self-serve credit topup. `amount_minor` is an
 * integer count of the currency's minor unit (cents, fen, …), bounded to a safe
 * integer so the downstream `BigInt()` conversion never loses precision. The
 * purpose is always `topup` (hardcoded by the service), so it is not in the body.
 *
 * `provider` is the `paymentProviderSchema` enum (`stripe`/`alipay`/…); the
 * frontend topup form narrows its `provider` state to this same inferred union.
 */
export const consoleCreateIntentSchema = z.object({
  provider: paymentProviderSchema,
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().min(1),
});
export type ConsoleCreateIntentBody = z.infer<typeof consoleCreateIntentSchema>;

/**
 * `PATCH /console/settings` — self-serve change-password. The new password
 * mirrors the registration policy (8–256 chars); the current one is verified
 * server-side against the stored scrypt hash before the swap.
 */
export const consoleChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});
export type ConsoleChangePasswordBody = z.infer<typeof consoleChangePasswordSchema>;

/**
 * `POST /console/users` (RBAC v1) — a tenant admin invites a sub-user. The
 * server creates a normal USER row (`role='user'`, `tenant_role='member'`) in the
 * caller's own tenant; the `password` is the member's initial credential (same
 * 8–256 policy as registration) and is NEVER logged. Admin-only (TenantAdminGuard).
 */
export const consoleCreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});
export type ConsoleCreateUserBody = z.infer<typeof consoleCreateUserSchema>;

/**
 * `PATCH /console/users/:id` (RBAC v1) — a tenant admin updates a sub-user's
 * `status` (active/disabled, the soft-disable) and/or `tenantRole` (promote/demote
 * member↔admin). All-optional so either dimension can be changed alone. Admin-only.
 */
export const consoleUpdateUserSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  tenantRole: z.enum(['admin', 'member']).optional(),
});
export type ConsoleUpdateUserBody = z.infer<typeof consoleUpdateUserSchema>;

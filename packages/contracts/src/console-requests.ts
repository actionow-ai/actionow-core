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
 * `tenantId`: the guard scopes it. An optional `subjectId` binds the key to one
 * of the caller-tenant's end-users (validated server-side to belong to the
 * tenant — a cross-tenant id → 404); omitted → a tenant-level key.
 */
export const consoleCreateApiKeySchema = z.object({
  resourceAllowlist: z.array(z.string()).optional(),
  /** Per-(tenant,resource) requests-per-minute cap; omitted → default. */
  rateLimit: z.number().int().positive().optional(),
  /** Bind the key to one of the caller-tenant's subjects (end-users); else tenant-level. */
  subjectId: z.string().uuid().optional(),
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
 * `POST /console/redeem` — a tenant admin redeems a gift/redemption code to
 * credit its OWN tenant account. No `tenantId`/`accountId` in the body: both are
 * supplied by the guard from the authenticated principal, so a code can only ever
 * be claimed for the caller's own tenant. The `code` is trimmed + non-empty.
 */
export const redeemCodeRequestSchema = z.object({
  code: z.string().trim().min(1),
});
export type RedeemCodeBody = z.infer<typeof redeemCodeRequestSchema>;

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

/**
 * `POST /console/conversations` (playground) — start a saved chat conversation for
 * the caller's tenant. Both fields optional: `title` defaults server-side ("新对话",
 * renameable), `model` records the picker's initial model. No `tenantId` (guard-scoped).
 */
export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().min(1).optional(),
});
export type CreateConversationBody = z.infer<typeof createConversationSchema>;

/**
 * `PATCH /console/conversations/:id` (playground) — rename and/or re-model a saved
 * conversation. All-optional so either dimension changes alone; `model` may be
 * cleared to `null`.
 */
export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().min(1).nullable().optional(),
});
export type UpdateConversationBody = z.infer<typeof updateConversationSchema>;

/**
 * `POST /console/conversations/:id/messages` (playground) — persist one turn. The
 * generation itself ran through the data-plane relay (API key); this only records
 * the transcript. `seq` is server-assigned. `usage`/`reasoning`/`latency_ms`/`model`
 * are assistant-turn metadata (omitted/null for a user turn). Field names mirror
 * `messageViewSchema` so the streamed result can be persisted with no remapping.
 */
export const appendMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  reasoning: z.string().nullable().optional(),
  usage: z.object({ input: z.number().int(), output: z.number().int() }).nullable().optional(),
  latency_ms: z.number().int().nonnegative().nullable().optional(),
  model: z.string().min(1).nullable().optional(),
});
export type AppendMessageBody = z.infer<typeof appendMessageSchema>;

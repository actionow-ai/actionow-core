import { z } from 'zod';

/**
 * Single source of truth for the core admin control-plane **request bodies**
 * (tenants, accounts, topups, API keys, secrets, redemption codes). Same
 * contract-first pattern as the `*-views.ts` files, but for the write side: the
 * backend admin DTO re-exports these schemas (so `ZodBody` validates against
 * them) and the frontend imports the inferred TYPE only (`import type`), so no
 * zod ships to the browser. These schemas flow into `openapi.json` →
 * `@actionow/sdk` as request bodies.
 *
 * CREDIT CONVENTION (write side): every credit-denominated field is a HUMAN
 * credit amount (e.g. `100` = 100 credits); the controller converts it to
 * integer µcredits with `creditsToMicro` before persisting. Unlike RESPONSE
 * money (always a string), request credits stay a `number`.
 */

/** `POST /admin/tenants` — create a tenant. */
export const createTenantSchema = z.object({
  name: z.string().min(1),
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type CreateTenantBody = z.infer<typeof createTenantSchema>;

/**
 * `PATCH /admin/tenants/:id` — update a tenant. Only `isolationMode` is mutable
 * here (the tenant name/id are not). There is intentionally NO tenant DELETE —
 * cascading a tenant removal from an admin route is too destructive.
 */
export const updateTenantSchema = z.object({
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type UpdateTenantBody = z.infer<typeof updateTenantSchema>;

/** `POST /admin/accounts` — create an account (opening balance in credits). */
export const createAccountSchema = z.object({
  tenantId: z.string().uuid(),
  /** Opening balance in HUMAN credits (converted to µcredits). */
  credits: z.number().nonnegative().optional(),
});
export type CreateAccountBody = z.infer<typeof createAccountSchema>;

/** `POST /admin/accounts/:id/topup` — credit an account (amount in credits). */
export const topupSchema = z.object({
  /** Amount in HUMAN credits to add (converted to µcredits). */
  credits: z.number().positive(),
});
export type TopupBody = z.infer<typeof topupSchema>;

/** `POST /admin/api-keys` — mint a key (plaintext returned once). */
export const createApiKeySchema = z.object({
  tenantId: z.string().uuid(),
  resourceAllowlist: z.array(z.string()).optional(),
  /** Per-(tenant,resource) requests-per-minute cap; omitted → default. */
  rateLimit: z.number().int().positive().optional(),
  /**
   * The route group (分组; Track 3) to bind this key to; omitted → null (the key
   * falls back to the `default` group at routing time). The service validates
   * the group exists.
   */
  routeGroupId: z.string().uuid().optional(),
});
export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>;

/**
 * `PATCH /admin/api-keys/:id/group` — (re)bind a key's route group (Track 3). The
 * `routeGroupId` is REQUIRED on the body but nullable: a uuid binds the key,
 * `null` unbinds it (→ the `default` group resolves at routing time). The
 * service validates a non-null group exists.
 */
export const updateApiKeyGroupSchema = z.object({
  routeGroupId: z.string().uuid().nullable(),
});
export type UpdateApiKeyGroupBody = z.infer<typeof updateApiKeyGroupSchema>;

/** `POST /admin/secrets` — create an encrypted-at-rest credential. */
export const createSecretSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
});
export type CreateSecretBody = z.infer<typeof createSecretSchema>;

/** `POST /admin/redemption-codes` — batch-mint codes. */
export const generateCodesSchema = z.object({
  /** How many codes to mint (1..1000). */
  count: z.number().int().min(1).max(1000),
  /** HUMAN-credit grant per code (converted to µcredits). */
  creditsPerCode: z.number().positive(),
  /** Optional ISO-8601 expiry; absent → never expires. */
  expiresAt: z.string().datetime().optional(),
});
export type GenerateCodesBody = z.infer<typeof generateCodesSchema>;

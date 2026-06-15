import { z } from 'zod';

/**
 * Zod request schemas for the admin CRUD surface. The contracts/domain packages
 * use zod, so the admin boundary does too (validated via the `ZodBody` pipe).
 *
 * CREDIT CONVENTION: every credit-denominated field below is a HUMAN credit
 * amount (e.g. `100` = 100 credits). The controller converts it to integer
 * µcredits with `creditsToMicro` before persisting; responses serialize the
 * stored µcredits as decimal strings. Schemas never carry µcredits.
 */

/** `POST /admin/tenants` — create a tenant. */
export const createTenantSchema = z.object({
  name: z.string().min(1),
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type CreateTenantDto = z.infer<typeof createTenantSchema>;

/** `POST /admin/accounts` — create an account (opening balance in credits). */
export const createAccountSchema = z.object({
  tenantId: z.string().uuid(),
  /** Opening balance in HUMAN credits (converted to µcredits). */
  credits: z.number().nonnegative().optional(),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

/** `POST /admin/accounts/:id/topup` — credit an account (amount in credits). */
export const topupSchema = z.object({
  /** Amount in HUMAN credits to add (converted to µcredits). */
  credits: z.number().positive(),
});
export type TopupDto = z.infer<typeof topupSchema>;

/** `POST /admin/api-keys` — mint a key (plaintext returned once). */
export const createApiKeySchema = z.object({
  tenantId: z.string().uuid(),
  resourceAllowlist: z.array(z.string()).optional(),
  /** Per-(tenant,resource) requests-per-minute cap; omitted → default. */
  rateLimit: z.number().int().positive().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/** `POST /admin/resources` — register a catalog resource (+ its io_schema). */
export const createResourceSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().uuid(),
  kind: z.enum(['model', 'workflow']),
  modality: z.enum(['text', 'image', 'video', 'audio', 'composite']),
  providerType: z.string().min(1),
  execModes: z.array(z.string().min(1)).min(1),
  /** The frozen io_schema snapshot (stored as jsonb). */
  ioSchema: z.unknown(),
  version: z.number().int().positive().optional(),
});
export type CreateResourceDto = z.infer<typeof createResourceSchema>;

/** `POST /admin/resources/:id/channels` — add an upstream routing channel. */
export const createChannelSchema = z.object({
  providerType: z.string().min(1),
  credentialRef: z.string().uuid().optional(),
  weight: z.number().int().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CreateChannelDto = z.infer<typeof createChannelSchema>;

/** `POST /admin/pricebook` — add a pricebook entry. */
export const createPricebookSchema = z.object({
  resourceId: z.string().min(1),
  resourceVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  method: z.enum(['unit', 'matrix', 'fixed', 'formula', 'passthrough']),
  timing: z.enum(['pre', 'post']),
  /**
   * The pricing spec (stored as jsonb). When `method` is `fixed`, `fixedCredits`
   * (below) is the HUMAN-credit amount; the controller converts it to a
   * µcredit `amount` inside the persisted spec. For metered/unit/matrix methods
   * the rate dimensions are already in the canonical unit the engine expects.
   */
  spec: z.unknown(),
  /**
   * Convenience for `method: 'fixed'`: a HUMAN-credit amount the controller
   * converts to µcredits and writes as `spec.amount`. Mutually informs `spec`.
   */
  fixedCredits: z.number().nonnegative().optional(),
  markup: z.unknown().optional(),
  active: z.boolean().optional(),
});
export type CreatePricebookDto = z.infer<typeof createPricebookSchema>;

/** `POST /admin/modifiers` — add a pricing modifier (§9.2 scope). */
export const createModifierSchema = z.object({
  /** `global` | `tenant:<id>` | `capability:<id>` | `resource:<id>`. */
  scope: z.string().min(1),
  whenExpr: z.string().optional(),
  op: z.enum(['override_rate', 'percent_off', 'flat_off', 'percent_add']),
  /**
   * For percent ops (`percent_off`/`percent_add`) this is a whole-percent int.
   * For credit ops (`flat_off`/`override_rate`) this is a HUMAN-credit amount
   * the controller converts to µcredits.
   */
  value: z.number().optional(),
  stackable: z.boolean().optional(),
  priority: z.number().int().optional(),
  version: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});
export type CreateModifierDto = z.infer<typeof createModifierSchema>;

/** `POST /admin/dify/import` — register a BYO Dify workflow. */
export const difyImportSchema = z.object({
  tenantId: z.string().uuid(),
  resourceId: z.string().min(1),
  yaml: z.string().min(1),
  endpoint: z.string().url(),
  serviceKeyRef: z.string().uuid().nullable().optional(),
  pricingModel: z.enum(['fixed', 'matrix', 'metered']),
  allowBlockers: z.boolean().optional(),
});
export type DifyImportDto = z.infer<typeof difyImportSchema>;

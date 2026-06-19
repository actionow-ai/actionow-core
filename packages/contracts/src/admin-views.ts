import { z } from 'zod';

/**
 * The single source of truth for the admin control-plane **wire views** (the
 * snake_case JSON the API serves). Backend `toView` mappers `.parse()` their
 * output against these schemas (so a drifting mapper fails loudly); the frontend
 * imports the inferred TYPE only (`import type`), so no zod ships to the browser.
 *
 * This is the B1 pilot of the contract-first pattern: define a resource's view
 * once here, derive both the backend response type and the frontend type from
 * it, and the hand-duplicated `interface TenantView` in apps/api and apps/web
 * collapses into one definition that cannot drift.
 */

/** A tenant as served by `GET /admin/tenants` (snake_case). */
export const tenantViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  isolation_mode: z.string(),
  created_at: z.string(),
});
export type TenantView = z.infer<typeof tenantViewSchema>;

/**
 * An account (balance/held view) as served by `GET /admin/accounts[/:id]`.
 * Money is a µcredit decimal **string** (bigint serialized), never a JS number.
 */
export const accountViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  credit_balance: z.string(),
  credit_held: z.string(),
  created_at: z.string(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

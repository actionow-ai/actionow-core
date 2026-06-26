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
  /** The tenant's bound limit plan (额度套餐), held on the account; `null` → none. */
  limit_plan_id: z.string().nullable(),
  created_at: z.string(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

/**
 * A **subject** (end-user) as served by `GET /admin/tenants/:id/users` (unified
 * tenancy). NEVER includes `password_hash`. `external_id` (Model B) and `email`
 * (Model A) are nullable; `limit_plan_id` is the per-subject governance plan.
 */
export const subjectViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  external_id: z.string().nullable(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  limit_plan_id: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type SubjectView = z.infer<typeof subjectViewSchema>;

/**
 * A per-subject **sub-wallet** (unified tenancy G-E, HARD mode) as served by
 * `GET /admin/tenants/:id/users/:sid/sub-account`. Money is a µcredit decimal
 * **string** (bigint serialized), never a JS number.
 */
export const subAccountViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  subject_id: z.string(),
  credit_balance: z.string(),
  credit_held: z.string(),
  status: z.string(),
  created_at: z.string(),
});
export type SubAccountView = z.infer<typeof subAccountViewSchema>;

/**
 * An admin SERVICE TOKEN (M2M credential) as served by `GET /admin/tokens`. NEVER
 * includes the token hash or plaintext — only metadata. `expires_at` is a nullable
 * ISO string (`null` → never expires); `created_by` is the minting admin's id.
 */
export const adminTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_by: z.string(),
  status: z.string(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminTokenView = z.infer<typeof adminTokenViewSchema>;

/**
 * The `POST /admin/provision` response: a tenant + its account + the one-time API
 * key plaintext (`{id, plaintext}`, shown ONCE), all created atomically.
 */
export const provisionViewSchema = z.object({
  tenant: tenantViewSchema,
  account: accountViewSchema,
  api_key: z.object({ id: z.string(), plaintext: z.string() }),
});
export type ProvisionView = z.infer<typeof provisionViewSchema>;

/**
 * The shared result of a bulk admin action (前端打磨 — `POST /admin/<entity>/bulk`).
 * PARTIAL SUCCESS: `succeeded` holds the ids whose per-id op completed; `failed`
 * pairs each remaining id with a human error message (e.g. `"not found"`). The
 * batch is never aborted by one bad id — every id lands in exactly one bucket.
 */
export const bulkResultViewSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});
export type BulkResultView = z.infer<typeof bulkResultViewSchema>;

/**
 * The newest `audit_log` row for one entity (前端打磨 — audit/version badges;
 * `POST /admin/audit-log/latest`). One element per `target_id` that has an audit
 * row (ids with no history are omitted from the response array, so the badge
 * renders nothing). `actor_id` is an operator/user id or `null` for system
 * actions; `created_at` is an ISO timestamp. The FE keys these by `target_id`
 * into a `Map` to render "{relativeTime} · {actor}" per row.
 */
export const latestAuditViewSchema = z.object({
  target_id: z.string(),
  actor_type: z.string(),
  actor_id: z.string().nullable(),
  action: z.string(),
  created_at: z.string(),
});
export type LatestAuditView = z.infer<typeof latestAuditViewSchema>;

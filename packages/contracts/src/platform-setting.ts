import { z } from 'zod';

/**
 * The allowlist of operator-tunable setting keys (动态配置). These are env vars
 * whose VALUE can be safely overridden at runtime (operational defaults +
 * feature flags) — NOT bootstrap / secrets / root-of-trust (those stay env-only).
 * The key strings mirror the env var names so an operator maps them 1:1; the
 * per-key value schema + env default live in `@actionow/infra` `SETTINGS_REGISTRY`.
 */
export const PLATFORM_SETTING_KEYS = [
  'RELAY_TRACE',
  'RELAY_TRACE_MAX_BYTES',
  'RELAY_TRACE_RETENTION_DAYS',
  'RATE_LIMIT_TENANT_PER_MIN',
  'RATE_LIMIT_RESOURCE_PER_MIN',
  'AUTH_RATE_LIMIT_PER_MIN',
  'STORAGE_MAX_UPLOAD_BYTES',
  'ALLOW_DEV_TENANT_HEADER',
  'CREDIT_RATE',
] as const;
export const platformSettingKeySchema = z.enum(PLATFORM_SETTING_KEYS);
export type PlatformSettingKey = z.infer<typeof platformSettingKeySchema>;

/** One effective setting row for the admin UI (env default overlaid by any DB override). */
export const platformSettingViewSchema = z.object({
  key: platformSettingKeySchema,
  /** The EFFECTIVE value (DB override if set+valid, else the env/code default). */
  value: z.unknown(),
  /** `db` = an operator override is in effect; `env` = the boot/code default. */
  source: z.enum(['env', 'db']),
  /** UI hint for the value editor, e.g. `number` / `boolean` / `enum: off | full`. */
  type: z.string(),
  description: z.string(),
  /** When/who last overrode it; null when source is `env`. */
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
});
export type PlatformSettingView = z.infer<typeof platformSettingViewSchema>;

/** Body for `PUT /admin/settings/:key` — the new value, validated per-key server-side. */
export const updatePlatformSettingRequestSchema = z.object({
  value: z.unknown(),
});
export type UpdatePlatformSettingRequest = z.infer<typeof updatePlatformSettingRequestSchema>;

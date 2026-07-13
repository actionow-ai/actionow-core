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
  // task_events retention (批次4 任务中心, §7.1/§9.3) — the registry entry lives
  // in infra SETTINGS_REGISTRY; the key MUST be mirrored here or the settings
  // view parse rejects the whole /admin/settings list.
  'TASK_EVENTS_RETENTION_DAYS',
  // §9.4 signed-track artifact retention platform default (批次4 slice5) —
  // same mirroring rule as above.
  'ARTIFACT_RETENTION_DAYS',
  // §9.2 对账偏差告警阈值 (批次4 slice6; 批次5 对账自动化消费) — same
  // mirroring rule as above.
  'RECONCILIATION_DEVIATION_PCT',
  // 切换预案② per-tenant 灰度: legacy 同步面走新网关的平台默认开关 (批次4
  // slice6; tenant.config.gateway_v2 per-tenant 覆盖).
  'GATEWAY_V2_DEFAULT',
  // R5 探测预算 (批次5 slice1 golden probe): daily platform budget (USD,
  // 平台自营渠道探测计入; BYOK 探测用租户自己的 key 不计入) + per-offering
  // minimum probe interval. Registry entries live in infra SETTINGS_REGISTRY;
  // keys MUST be mirrored here (the settings view parse rejects unknowns).
  'PROBE_DAILY_BUDGET_USD',
  'PROBE_MIN_INTERVAL_SEC',
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

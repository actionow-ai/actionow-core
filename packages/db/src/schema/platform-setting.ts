import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Operator-tunable platform settings (动态配置). One row per OVERRIDDEN setting
 * key; the ABSENCE of a row means "use the env/code default" — the
 * `SettingsResolver` overlays these rows on the env-derived defaults, so an
 * unset key is exactly today's behavior. Only the small allowlist of
 * dynamic-safe keys (see `@actionow/infra` `SETTINGS_REGISTRY`) is ever written;
 * bootstrap / secret / root-of-trust env (`DATABASE_URL`, `SECRET_ENCRYPTION_KEY`,
 * `ADMIN_JWT_SECRET`, `HTTP_EGRESS`, …) is intentionally NOT dynamic. Mutated in
 * place by the admin API; `updated_by` attributes the change (also mirrored to
 * `audit_log` via `@Audit`).
 */
export const platformSetting = pgTable('platform_setting', {
  key: text('key').primaryKey(),
  /** The typed value as JSON (number/boolean/string/enum); validated on write by the registry schema. */
  value: jsonb('value').$type<unknown>().notNull(),
  /** The admin id (`req.admin.adminId`) who last set it; null for a seed/system write. */
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

import { z } from 'zod';

import type { AppEnv } from './config.js';

/**
 * The login-throttle built-in default (mirrors `LoginThrottleGuard`); used as the
 * code default for `AUTH_RATE_LIMIT_PER_MIN` when neither env nor a DB override is set.
 */
const DEFAULT_AUTH_RATE_LIMIT_PER_MIN = 10;

/** One dynamic-config setting: how to validate an override value + derive the env/code default. */
export interface SettingDef<T> {
  /** Validates an admin/DB-supplied value; a bad value is rejected (write) or ignored (read). */
  readonly schema: z.ZodType<T>;
  /** The default when no override row exists (env value, else a code fallback). */
  readonly default: (env: AppEnv) => T;
  /** UI hint for the value editor. */
  readonly type: string;
  /** Operator-facing description (zh). */
  readonly description: string;
}

/** Identity helper that preserves each entry's value type `T` in the registry. */
function def<T>(d: SettingDef<T>): SettingDef<T> {
  return d;
}

/**
 * The dynamic-config registry (动态配置): the allowlist of env whose VALUE can be
 * overridden at runtime via `platform_setting` + the admin API. Bootstrap /
 * secrets / root-of-trust env (DATABASE_URL, SECRET_ENCRYPTION_KEY,
 * ADMIN_JWT_SECRET, HTTP_EGRESS, API_PORT, NODE_ENV, …) is deliberately ABSENT —
 * those stay env-only. Keys mirror the env var names exactly.
 */
export const SETTINGS_REGISTRY = {
  RELAY_TRACE: def({
    schema: z.enum(['off', 'full']),
    default: (e: AppEnv) => e.RELAY_TRACE,
    type: 'enum: off | full',
    description: '上游请求/响应全量审计追踪开关（排障用，默认 off）',
  }),
  RELAY_TRACE_MAX_BYTES: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.RELAY_TRACE_MAX_BYTES,
    type: 'number',
    description: 'relay_trace 单条 body 截断上限（字节）',
  }),
  RATE_LIMIT_TENANT_PER_MIN: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.RATE_LIMIT_TENANT_PER_MIN,
    type: 'number',
    description: '租户级默认限流（请求/分钟）',
  }),
  RATE_LIMIT_RESOURCE_PER_MIN: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.RATE_LIMIT_RESOURCE_PER_MIN,
    type: 'number',
    description: '（租户,资源）级默认限流（请求/分钟）；API key 自带 rateLimit 时被覆盖',
  }),
  AUTH_RATE_LIMIT_PER_MIN: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.AUTH_RATE_LIMIT_PER_MIN ?? DEFAULT_AUTH_RATE_LIMIT_PER_MIN,
    type: 'number',
    description: '未鉴权 auth 端点每 IP 限流（请求/分钟）',
  }),
  STORAGE_MAX_UPLOAD_BYTES: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.STORAGE_MAX_UPLOAD_BYTES,
    type: 'number',
    description: '预签名上传声明大小上限（字节）',
  }),
  ALLOW_DEV_TENANT_HEADER: def({
    schema: z.boolean(),
    default: (e: AppEnv) => e.ALLOW_DEV_TENANT_HEADER,
    type: 'boolean',
    description: '非生产下是否允许 x-tenant-id 回退（生产恒关，与此无关）',
  }),
  CREDIT_RATE: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.CREDIT_RATE,
    type: 'number',
    description: '每货币最小单位授予的 µUSD；仅影响新建 topup 意图，绝不回溯重定价',
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> =
  (typeof SETTINGS_REGISTRY)[K] extends SettingDef<infer T> ? T : never;

/** All registry keys (typed), in declaration order. */
export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

/** One resolved setting: the effective value + provenance, ready to map to a view. */
export interface EffectiveSetting<T = unknown> {
  readonly key: SettingKey;
  readonly value: T;
  readonly source: 'env' | 'db';
  readonly type: string;
  readonly description: string;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** A persisted override row (shape only — keeps this module db-free). */
export interface SettingOverrideRow {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/**
 * Overlay the override rows onto the env-derived defaults — PURE (no I/O). An
 * override whose value fails its registry schema is IGNORED (the key falls back
 * to its env default, `source:'env'`) so a malformed row can never break a read.
 */
export function resolveEffectiveSettings(
  env: AppEnv,
  rows: readonly SettingOverrideRow[],
): Record<SettingKey, EffectiveSetting> {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = {} as Record<SettingKey, EffectiveSetting>;
  for (const key of SETTING_KEYS) {
    const d = SETTINGS_REGISTRY[key];
    const base: EffectiveSetting = {
      key,
      value: d.default(env),
      source: 'env',
      type: d.type,
      description: d.description,
      updatedAt: null,
      updatedBy: null,
    };
    const row = byKey.get(key);
    if (row !== undefined) {
      const parsed = d.schema.safeParse(row.value);
      if (parsed.success) {
        out[key] = {
          ...base,
          value: parsed.data,
          source: 'db',
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        };
        continue;
      }
    }
    out[key] = base;
  }
  return out;
}

/** Validate + coerce an admin-supplied value for one key. Throws `ZodError` on a bad value. */
export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS_REGISTRY[key].schema.parse(value) as SettingValue<K>;
}

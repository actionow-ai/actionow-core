import { z } from 'zod';

import type { AppEnv } from './config.js';

/**
 * The login-throttle built-in default (mirrors `LoginThrottleGuard`); used as the
 * code default for `AUTH_RATE_LIMIT_PER_MIN` when neither env nor a DB override is set.
 */
const DEFAULT_AUTH_RATE_LIMIT_PER_MIN = 10;

/**
 * task_events retention code default (批次4, design §7.1/§9.3: 「retention 与
 * relay_trace 同策略配置，不默认永久」) — unlike RELAY_TRACE_RETENTION_DAYS
 * (unset = keep forever), task_events ALWAYS has a finite window: env unset →
 * this constant. Events are ≤4KB clipped payloads, so a generous 90 days keeps
 * audit value without unbounded growth.
 */
const DEFAULT_TASK_EVENTS_RETENTION_DAYS = 90;

/**
 * §9.4 signed-track artifact retention code default (批次4 slice5): applies
 * when a model declares no artifact.retention_days and no env/admin override
 * exists. 30 days mirrors mainstream provider artifact windows; the signed
 * track ALWAYS expires (只有 public 轨可豁免清理), so this is never unset.
 */
const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

/**
 * §9.2 对账 code default (批次4 slice6): the deviation percentage the
 * official-channel daily auto-reconciliation alerts on. 5% mirrors common
 * billing-tolerance practice; the 批次5 automated comparer reads it through
 * the SettingsResolver so operators can tune it without a deploy.
 */
const DEFAULT_RECONCILIATION_DEVIATION_PCT = 5;

/**
 * R5 探测预算 code defaults (批次5 slice1 golden probe): the daily USD budget
 * for PLATFORM-FUNDED probes (BYOK probes ride the tenant's own key and are
 * not counted) and the per-offering minimum probe interval. 5 USD/day bounds
 * a runaway batch-probe loop at roughly 25 media probes or hundreds of chat
 * pings; 60 s stops per-offering hammering of a real upstream.
 */
const DEFAULT_PROBE_DAILY_BUDGET_USD = 5;
const DEFAULT_PROBE_MIN_INTERVAL_SEC = 60;

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
  RELAY_TRACE_RETENTION_DAYS: def<number | undefined>({
    // Optional: a positive day-count enables the worker's relay-trace reaper;
    // unset (reset-to-default with no env) keeps traces forever (no sweep).
    schema: z.number().int().positive().optional(),
    default: (e: AppEnv) => e.RELAY_TRACE_RETENTION_DAYS,
    type: 'number',
    description: 'relay_trace 留存天数；设置后由后台清理超期追踪，留空=永久保留',
  }),
  TASK_EVENTS_RETENTION_DAYS: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.TASK_EVENTS_RETENTION_DAYS ?? DEFAULT_TASK_EVENTS_RETENTION_DAYS,
    type: 'number',
    description: 'task_events 事件流留存天数；后台按天清理超期事件（不默认永久，缺省 90 天）',
  }),
  ARTIFACT_RETENTION_DAYS: def({
    schema: z.number().int().positive(),
    default: (e: AppEnv) => e.ARTIFACT_RETENTION_DAYS ?? DEFAULT_ARTIFACT_RETENTION_DAYS,
    type: 'number',
    description:
      '签名轨产物保留天数平台默认（模型未声明 retention_days 时生效；到期标记 expired，缺省 30 天）',
  }),
  RECONCILIATION_DEVIATION_PCT: def({
    schema: z.number().positive(),
    default: (e: AppEnv) => e.RECONCILIATION_DEVIATION_PCT ?? DEFAULT_RECONCILIATION_DEVIATION_PCT,
    type: 'number',
    description:
      '对账偏差告警阈值（百分比）：官方渠道按日自动对账时，usage 计算成本与上游账单口径偏差超过该值即告警（批次5 对账自动化消费；月度报表不受其影响，缺省 5）',
  }),
  PROBE_DAILY_BUDGET_USD: def({
    schema: z.number().positive(),
    default: (e: AppEnv) => e.PROBE_DAILY_BUDGET_USD ?? DEFAULT_PROBE_DAILY_BUDGET_USD,
    type: 'number',
    description:
      'golden probe 平台日预算（USD）：真上游探测按估算成本计入，当日预算耗尽即拒绝新探测（budget_exceeded）；仅计平台自营渠道，BYOK 渠道用租户自己的 key 不计入（缺省 5）',
  }),
  PROBE_MIN_INTERVAL_SEC: def({
    schema: z.number().int().nonnegative(),
    default: (e: AppEnv) => e.PROBE_MIN_INTERVAL_SEC ?? DEFAULT_PROBE_MIN_INTERVAL_SEC,
    type: 'number',
    description:
      'golden probe 单供给项最小探测间隔（秒）：间隔未到即拒绝（min_interval），防止对真上游高频锤击；0 = 不限（缺省 60）',
  }),
  GATEWAY_V2_DEFAULT: def({
    schema: z.boolean(),
    default: (e: AppEnv) => e.GATEWAY_V2_DEFAULT ?? false,
    type: 'boolean',
    description:
      '切换预案②：legacy 同步面（chat/embeddings…）走新供给网关的平台默认灰度开关；tenant.config.gateway_v2 可 per-tenant 覆盖（缺省 false，新任务面端点不受此开关影响）',
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

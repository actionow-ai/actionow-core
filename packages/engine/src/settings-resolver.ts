import { type DbOrTx, listPlatformSettings } from '@actionow/db';
import type { AppEnv, EffectiveSetting, SettingKey, SettingValue } from '@actionow/infra';
import { resolveEffectiveSettings } from '@actionow/infra';

export interface SettingsResolverDeps {
  readonly db: DbOrTx;
  readonly env: AppEnv;
  /** Cache TTL in ms; default 10s (cross-replica propagation is bounded by this). */
  readonly ttlMs?: number;
  /** Injectable clock for tests; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Resolves the effective value of each dynamic setting (动态配置): the env/code
 * default overlaid by any `platform_setting` override row, cached in-process for
 * a short TTL so a hot path doesn't hit the DB per call. Two invariants borrowed
 * from the breaker/governance house style:
 *  - **fail-open**: a DB read error falls back to pure env defaults — a settings
 *    outage never throws into a request path.
 *  - **bounded staleness**: a write in one replica is reflected here within
 *    `ttlMs` (the writing replica also calls {@link invalidate} for immediacy).
 *
 * Framework-free: both the api (`SettingsService`) and the worker runtime wrap one.
 */
export class SettingsResolver {
  private readonly db: DbOrTx;
  private readonly env: AppEnv;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: Record<SettingKey, EffectiveSetting> | null = null;
  private cachedAt = 0;

  constructor(deps: SettingsResolverDeps) {
    this.db = deps.db;
    this.env = deps.env;
    this.ttlMs = deps.ttlMs ?? 10_000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** All effective settings (env overlaid by valid overrides), cached for `ttlMs`. */
  async getAll(): Promise<Record<SettingKey, EffectiveSetting>> {
    const t = this.now();
    if (this.cache !== null && t - this.cachedAt < this.ttlMs) return this.cache;
    let rows: Awaited<ReturnType<typeof listPlatformSettings>> = [];
    try {
      rows = await listPlatformSettings(this.db);
    } catch {
      rows = []; // fail-open: DB unavailable → pure env defaults, never throw to callers
    }
    this.cache = resolveEffectiveSettings(this.env, rows);
    this.cachedAt = t;
    return this.cache;
  }

  /** The effective value of one setting (typed). */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return (await this.getAll())[key].value as SettingValue<K>;
  }

  /** Drop the cache so the next read re-fetches (call after an admin write). */
  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }
}

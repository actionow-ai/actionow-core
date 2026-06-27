import {
  type PlatformSettingView,
  platformSettingViewSchema,
} from '@actionow/contracts';
import { type Database, deletePlatformSetting, upsertPlatformSetting } from '@actionow/db';
import { SettingsResolver } from '@actionow/engine';
import { type AppEnv, parseSettingValue, type SettingKey, type SettingValue } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';

/**
 * The api facade over the engine {@link SettingsResolver} (动态配置). Holds one
 * shared resolver (singleton) so every guard/service reads the same cached
 * env+DB overlay. Reads via {@link get}; the admin API mutates via {@link set} /
 * {@link reset} (which validate against the registry + invalidate the cache).
 */
@Injectable()
export class SettingsService {
  private readonly resolver: SettingsResolver;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: AppEnv,
  ) {
    this.resolver = new SettingsResolver({ db, env });
  }

  /** Effective value of one setting (DB override if set+valid, else env default). */
  get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return this.resolver.get(key);
  }

  /** All effective settings as admin views (env overlaid by overrides, with provenance). */
  async list(): Promise<PlatformSettingView[]> {
    const all = await this.resolver.getAll();
    return Object.values(all).map((s) =>
      platformSettingViewSchema.parse({
        key: s.key,
        value: s.value,
        source: s.source,
        type: s.type,
        description: s.description,
        updated_at: s.updatedAt?.toISOString() ?? null,
        updated_by: s.updatedBy,
      }),
    );
  }

  /** Override one setting; validates the value against the registry (400 on bad value). */
  async set(
    key: SettingKey,
    rawValue: unknown,
    updatedBy: string | null,
  ): Promise<PlatformSettingView> {
    let value: unknown;
    try {
      value = parseSettingValue(key, rawValue);
    } catch {
      throw engineInvalidInput(`invalid value for setting ${key}`);
    }
    await upsertPlatformSetting(this.db, key, value, updatedBy);
    this.resolver.invalidate();
    return this.viewOf(key);
  }

  /** Remove a setting override → reverts to the env/code default. (Actor is captured via @Audit.) */
  async reset(key: SettingKey): Promise<PlatformSettingView> {
    await deletePlatformSetting(this.db, key);
    this.resolver.invalidate();
    return this.viewOf(key);
  }

  private async viewOf(key: SettingKey): Promise<PlatformSettingView> {
    const view = (await this.list()).find((s) => s.key === key);
    if (view === undefined) throw engineInvalidInput(`unknown setting ${key}`);
    return view;
  }
}

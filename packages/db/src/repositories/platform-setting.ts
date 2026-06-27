import type { InferSelectModel } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

import { platformSetting } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type PlatformSettingRow = InferSelectModel<typeof platformSetting>;

/** Read every overridden setting row. Absent keys fall back to env defaults (resolver). */
export async function listPlatformSettings(db: DbOrTx): Promise<PlatformSettingRow[]> {
  return db.select().from(platformSetting);
}

/** Upsert one setting override (the value is already validated by the caller against the registry). */
export async function upsertPlatformSetting(
  db: DbOrTx,
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  await db
    .insert(platformSetting)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({
      target: platformSetting.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
}

/** Remove a setting override → the key reverts to its env/code default. No-op if absent. */
export async function deletePlatformSetting(db: DbOrTx, key: string): Promise<void> {
  await db.delete(platformSetting).where(eq(platformSetting.key, key));
}

import type { InferSelectModel } from 'drizzle-orm';
import { asc } from 'drizzle-orm';

import { iconAsset } from '../schema/icon.js';
import type { DbOrTx } from './types.js';

export type IconAssetRow = InferSelectModel<typeof iconAsset>;

/** The selectable icon catalog (for the picker), ordered by category then key. */
export async function listIconAssets(db: DbOrTx): Promise<IconAssetRow[]> {
  return db.select().from(iconAsset).orderBy(asc(iconAsset.category), asc(iconAsset.key));
}

/** Idempotently install/refresh a seeded icon (by `key`). */
export async function upsertIconAsset(
  db: DbOrTx,
  input: { key: string; label: string; category?: string; svg?: string | null },
): Promise<void> {
  await db
    .insert(iconAsset)
    .values({
      key: input.key,
      label: input.label,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.svg !== undefined ? { svg: input.svg } : {}),
    })
    .onConflictDoUpdate({
      target: iconAsset.key,
      set: {
        label: input.label,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.svg !== undefined ? { svg: input.svg } : {}),
      },
    });
}

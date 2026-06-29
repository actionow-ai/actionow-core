import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import {
  channelModel,
  model,
  providerPlugin,
  providerPluginVersion,
  upstreamChannel,
} from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type ProviderPluginRow = InferSelectModel<typeof providerPlugin>;

/** Per-plugin live channel + distinct-model counts (模型接入 card stats). */
export interface PluginCounts {
  channels: number;
  models: number;
}

/**
 * Count, per plugin, its LIVE bound channels and the DISTINCT live models those
 * channels serve — backs the plugin card's `通道 N · 模型 M` + the default
 * model-count sort. A model linked to several of a plugin's channels counts once.
 */
export async function countByPlugin(db: DbOrTx): Promise<Map<string, PluginCounts>> {
  const rows = await db
    .select({
      pid: upstreamChannel.pluginId,
      channels: sql<number>`count(distinct ${upstreamChannel.id})::int`,
      models: sql<number>`count(distinct ${model.id})::int`,
    })
    .from(upstreamChannel)
    .leftJoin(channelModel, eq(channelModel.channelId, upstreamChannel.id))
    .leftJoin(model, and(eq(model.id, channelModel.modelId), isNull(model.deletedAt)))
    .where(and(isNull(upstreamChannel.deletedAt), isNotNull(upstreamChannel.pluginId)))
    .groupBy(upstreamChannel.pluginId);
  const out = new Map<string, PluginCounts>();
  for (const r of rows)
    if (r.pid !== null) out.set(r.pid, { channels: r.channels, models: r.models });
  return out;
}

/** Write the immutable version-history snapshot for a plugin row (spec §3.6 freeze). */
async function snapshotVersion(db: DbOrTx, row: ProviderPluginRow): Promise<void> {
  await db
    .insert(providerPluginVersion)
    .values({
      pluginId: row.id,
      version: row.version,
      manifest: row.manifest,
      handler: row.handler,
    })
    .onConflictDoNothing({
      target: [providerPluginVersion.pluginId, providerPluginVersion.version],
    });
}

/** Fetch a FROZEN plugin version snapshot (manifest+handler) — the freeze read path. */
export async function getPluginVersion(
  db: DbOrTx,
  pluginId: string,
  version: number,
): Promise<{ manifest: Record<string, unknown>; handler: string } | undefined> {
  const rows = await db
    .select()
    .from(providerPluginVersion)
    .where(
      and(eq(providerPluginVersion.pluginId, pluginId), eq(providerPluginVersion.version, version)),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : { manifest: row.manifest, handler: row.handler };
}

/** Fields to create one `provider_plugin`. */
export interface CreatePluginInput {
  slug: string;
  label: string;
  modalities: string[];
  protocol: string;
  authStrategy: string;
  manifest: Record<string, unknown>;
  handler: string;
  builtin?: boolean;
  /** Selectable icon key (icon_asset.key); null/omitted → derived from slug. */
  icon?: string | null | undefined;
}

/** Editable fields (manifest/handler edits bump `version`). */
export interface UpdatePluginInput {
  label?: string;
  modalities?: string[];
  protocol?: string;
  authStrategy?: string;
  manifest?: Record<string, unknown>;
  handler?: string;
  /** Selectable icon key (icon_asset.key); `null` clears it. */
  icon?: string | null | undefined;
  status?: string;
}

/** List active (non-soft-deleted) plugins, ordered by slug. */
export function listPlugins(db: DbOrTx): Promise<ProviderPluginRow[]> {
  return db
    .select()
    .from(providerPlugin)
    .where(isNull(providerPlugin.deletedAt))
    .orderBy(providerPlugin.slug);
}

/** Fetch one plugin by its stable slug (active only). */
export async function getPluginBySlug(
  db: DbOrTx,
  slug: string,
): Promise<ProviderPluginRow | undefined> {
  const rows = await db
    .select()
    .from(providerPlugin)
    .where(and(eq(providerPlugin.slug, slug), isNull(providerPlugin.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fetch one plugin by id (active only). */
export async function getPluginById(
  db: DbOrTx,
  id: string,
): Promise<ProviderPluginRow | undefined> {
  const rows = await db
    .select()
    .from(providerPlugin)
    .where(and(eq(providerPlugin.id, id), isNull(providerPlugin.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Insert a new plugin at version 1. */
export async function createPlugin(
  db: DbOrTx,
  input: CreatePluginInput,
): Promise<ProviderPluginRow> {
  const rows = await db
    .insert(providerPlugin)
    .values({
      slug: input.slug,
      label: input.label,
      modalities: input.modalities,
      protocol: input.protocol,
      authStrategy: input.authStrategy,
      manifest: input.manifest,
      handler: input.handler,
      builtin: input.builtin ?? false,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createPlugin: insert returned no row');
  await snapshotVersion(db, row);
  return row;
}

/**
 * Patch a plugin; ANY edit bumps `version` so a `resource_version` that froze an
 * older snapshot keeps running it (spec §3.6). Returns undefined if not found.
 */
export async function updatePlugin(
  db: DbOrTx,
  id: string,
  patch: UpdatePluginInput,
): Promise<ProviderPluginRow | undefined> {
  const rows = await db
    .update(providerPlugin)
    .set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.modalities !== undefined ? { modalities: patch.modalities } : {}),
      ...(patch.protocol !== undefined ? { protocol: patch.protocol } : {}),
      ...(patch.authStrategy !== undefined ? { authStrategy: patch.authStrategy } : {}),
      ...(patch.manifest !== undefined ? { manifest: patch.manifest } : {}),
      ...(patch.handler !== undefined ? { handler: patch.handler } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      version: sql`${providerPlugin.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(providerPlugin.id, id), isNull(providerPlugin.deletedAt)))
    .returning();
  const row = rows[0];
  if (row !== undefined) await snapshotVersion(db, row);
  return row;
}

/**
 * Idempotently install/refresh a built-in plugin by slug (seed path): insert, or
 * on slug conflict refresh manifest/handler + bump version. Always `builtin:true`.
 */
export async function upsertBuiltinPlugin(
  db: DbOrTx,
  input: CreatePluginInput,
): Promise<ProviderPluginRow> {
  const rows = await db
    .insert(providerPlugin)
    .values({
      slug: input.slug,
      label: input.label,
      modalities: input.modalities,
      protocol: input.protocol,
      authStrategy: input.authStrategy,
      manifest: input.manifest,
      handler: input.handler,
      builtin: true,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    })
    .onConflictDoUpdate({
      target: providerPlugin.slug,
      // `provider_plugin_slug_uq` is a PARTIAL unique index (slug WHERE deleted_at
      // IS NULL, mig 0052), so the ON CONFLICT arbiter needs the matching predicate
      // — without it Postgres can't infer the index (42P10), which broke seeding
      // against a fresh fully-migrated DB.
      targetWhere: isNull(providerPlugin.deletedAt),
      set: {
        label: input.label,
        modalities: input.modalities,
        protocol: input.protocol,
        authStrategy: input.authStrategy,
        manifest: input.manifest,
        handler: input.handler,
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        version: sql`${providerPlugin.version} + 1`,
        updatedAt: new Date(),
        deletedAt: null,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertBuiltinPlugin: upsert returned no row');
  await snapshotVersion(db, row);
  return row;
}

/** Soft-delete a plugin (sets `deleted_at`). */
export async function softDeletePlugin(db: DbOrTx, id: string): Promise<void> {
  await db.update(providerPlugin).set({ deletedAt: new Date() }).where(eq(providerPlugin.id, id));
}

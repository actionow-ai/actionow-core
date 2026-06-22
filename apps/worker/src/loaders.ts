import type { Modifier, PricebookEntry } from '@actionow/contracts';
import { pluginManifestSchema } from '@actionow/contracts';
import {
  type Database,
  getAccountByTenant,
  getActivePricebookEntry,
  getPluginById,
  getPluginVersion,
  getResource,
  type Job,
  listApplicableModifiers,
  listChannels,
  type ModifierRow,
  type PricebookEntryRow,
} from '@actionow/db';
import type { JobExecutionContext, RunChannel } from '@actionow/engine';
import { PLUGIN_PROVIDER_TYPE } from '@actionow/engine';

/**
 * Build the {@link JobExecutionContext} the engine's `JobRunner` needs from a
 * persisted job: resolve the account, the active pricebook entry, the upstream
 * channels, and the active modifiers for the job's resource/version. Mirrors
 * the api `RunService` mapping so a job runs the same whether it was driven
 * inline (blocking) or by the worker (async).
 */
export async function loadJobContext(db: Database, job: Job): Promise<JobExecutionContext> {
  const resource = await getResource(db, job.resourceId);
  if (resource === undefined) {
    throw new Error(`loadJobContext: resource ${job.resourceId} not found`);
  }

  const account = await getAccountByTenant(db, job.tenantId);
  if (account === undefined) {
    throw new Error(`loadJobContext: no account for tenant ${job.tenantId}`);
  }

  const pricebook = await getActivePricebookEntry(db, job.resourceId, job.resourceVersion);
  if (pricebook === undefined) {
    throw new Error(`loadJobContext: no active pricebook for resource ${job.resourceId}`);
  }

  const channelRows = await listChannels(db, job.resourceId);
  const modifierRows = await listApplicableModifiers(db, {
    tenantId: job.tenantId,
    resourceId: job.resourceId,
  });

  return {
    accountId: account.id,
    providerType: resource.providerType,
    modality: resource.modality,
    pricebookEntry: toPricebookEntry(pricebook),
    modifiers: modifierRows.map(toModifier),
    channels: await Promise.all(channelRows.map((c) => toRunChannel(db, c))),
  };
}

/**
 * Map one channel row → {@link RunChannel}. A plugin-bound channel
 * (`plugin_id`) loads the plugin snapshot (manifest + handler) and routes to the
 * generic plugin adapter (`providerType='plugin'`); others keep their code
 * adapter. NOTE: T7 will load the FROZEN snapshot from `resource_version`; for now
 * the live plugin row is used.
 */
async function toRunChannel(
  db: Database,
  c: Awaited<ReturnType<typeof listChannels>>[number],
): Promise<RunChannel> {
  const base: RunChannel = {
    id: c.id,
    weight: c.weight,
    credentialRef: c.credentialRef ?? undefined,
    endpoint: c.endpoint ?? undefined,
    model: c.model ?? undefined,
    proxyRef: c.proxyRef ?? undefined,
    config: c.config ?? undefined,
  };
  if (c.pluginId !== null) {
    // Prefer the FROZEN snapshot the channel pinned (spec §3.6); fall back to the
    // live plugin row when no version is pinned (or the snapshot is missing).
    let snap: { manifest: Record<string, unknown>; handler: string } | undefined;
    if (c.pluginVersion !== null) {
      snap = await getPluginVersion(db, c.pluginId, c.pluginVersion);
    }
    if (snap === undefined) {
      const p = await getPluginById(db, c.pluginId);
      if (p !== undefined) snap = { manifest: p.manifest, handler: p.handler };
    }
    if (snap !== undefined) {
      return {
        ...base,
        providerType: PLUGIN_PROVIDER_TYPE,
        plugin: { manifest: pluginManifestSchema.parse(snap.manifest), handler: snap.handler },
      };
    }
  }
  return base;
}

function toPricebookEntry(row: PricebookEntryRow): PricebookEntry {
  const entry: PricebookEntry = {
    resourceId: row.resourceId,
    resourceVersion: row.resourceVersion,
    version: row.version,
    method: row.method as PricebookEntry['method'],
    timing: row.timing as PricebookEntry['timing'],
    spec: row.spec,
  };
  if (row.markup !== null) entry.markup = row.markup;
  return entry;
}

function toModifier(row: ModifierRow): Modifier {
  const modifier: Modifier = {
    id: row.id,
    scope: row.scope,
    op: row.op as Modifier['op'],
    stackable: row.stackable,
    priority: row.priority,
    version: row.version,
  };
  if (row.whenExpr !== null) modifier.whenExpr = row.whenExpr;
  if (row.value !== null) modifier.value = Number(row.value);
  return modifier;
}

import type { Modifier, PricebookEntry } from '@actionow/contracts';
import {
  type Database,
  getAccountByTenant,
  getActivePricebookEntry,
  getResource,
  type Job,
  listActiveModifiers,
  listChannels,
  type ModifierRow,
  type PricebookEntryRow,
} from '@actionow/db';
import type { JobExecutionContext } from '@actionow/engine';

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
  const modifierRows = await listActiveModifiers(db);

  return {
    accountId: account.id,
    providerType: resource.providerType,
    modality: resource.modality,
    pricebookEntry: toPricebookEntry(pricebook),
    modifiers: modifierRows.map(toModifier),
    channels: channelRows.map((c) => ({
      id: c.id,
      weight: c.weight,
      credentialRef: c.credentialRef ?? undefined,
    })),
  };
}

function toPricebookEntry(row: PricebookEntryRow): PricebookEntry {
  const entry: PricebookEntry = {
    resourceId: row.resourceId,
    resourceVersion: row.resourceVersion,
    version: row.version,
    method: row.method as PricebookEntry['method'],
    timing: row.timing as PricebookEntry['timing'],
    spec: row.spec as PricebookEntry['spec'],
  };
  if (row.markup !== null) entry.markup = row.markup as PricebookEntry['markup'];
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

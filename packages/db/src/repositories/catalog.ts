import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq } from 'drizzle-orm';

import {
  account,
  modifier,
  pricebookEntry,
  resource,
  resourceVersion,
  upstreamChannel,
} from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type Resource = InferSelectModel<typeof resource>;
export type ResourceVersionRow = InferSelectModel<typeof resourceVersion>;
export type PricebookEntryRow = InferSelectModel<typeof pricebookEntry>;
export type ModifierRow = InferSelectModel<typeof modifier>;
export type UpstreamChannelRow = InferSelectModel<typeof upstreamChannel>;

/** Fetch a resource row by id, or `undefined`. */
export async function getResource(db: DbOrTx, resourceId: string): Promise<Resource | undefined> {
  const rows = await db.select().from(resource).where(eq(resource.id, resourceId)).limit(1);
  return rows[0];
}

/** Fetch the frozen `io_schema` snapshot for a specific resource version. */
export async function getResourceVersion(
  db: DbOrTx,
  resourceId: string,
  version: number,
): Promise<ResourceVersionRow | undefined> {
  const rows = await db
    .select()
    .from(resourceVersion)
    .where(and(eq(resourceVersion.resourceId, resourceId), eq(resourceVersion.version, version)))
    .limit(1);
  return rows[0];
}

/**
 * Fetch the active pricebook entry for a resource version, newest `version`
 * first. Returns `undefined` when no active entry exists.
 */
export async function getActivePricebookEntry(
  db: DbOrTx,
  resourceId: string,
  resourceVersionNumber: number,
): Promise<PricebookEntryRow | undefined> {
  const rows = await db
    .select()
    .from(pricebookEntry)
    .where(
      and(
        eq(pricebookEntry.resourceId, resourceId),
        eq(pricebookEntry.resourceVersion, resourceVersionNumber),
        eq(pricebookEntry.active, true),
      ),
    )
    .orderBy(desc(pricebookEntry.version))
    .limit(1);
  return rows[0];
}

/** List the active upstream channels for a resource (routing candidates). */
export async function listChannels(db: DbOrTx, resourceId: string): Promise<UpstreamChannelRow[]> {
  return db
    .select()
    .from(upstreamChannel)
    .where(and(eq(upstreamChannel.resourceId, resourceId), eq(upstreamChannel.status, 'active')));
}

/**
 * List the active modifiers applicable to a run, highest `priority` first.
 * Scope filtering (per-tenant/per-resource) is a Phase-5 concern; for Phase 3
 * we return every active modifier and let the domain `applyModifiers` decide
 * what fires via each modifier's `whenExpr`.
 */
export async function listActiveModifiers(db: DbOrTx): Promise<ModifierRow[]> {
  return db
    .select()
    .from(modifier)
    .where(eq(modifier.active, true))
    .orderBy(desc(modifier.priority));
}

/**
 * Resolve the single account for a tenant. Phase 3 assumes one account per
 * tenant (multi-account billing is a later phase). Returns `undefined` when the
 * tenant has no account.
 */
export async function getAccountByTenant(
  db: DbOrTx,
  tenantId: string,
): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.tenantId, tenantId))
    .limit(1);
  return rows[0];
}

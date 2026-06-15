import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, desc, eq } from 'drizzle-orm';

import {
  account,
  difyBinding,
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
export type DifyBindingRow = InferSelectModel<typeof difyBinding>;

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

/** Fields a caller supplies to {@link createResource}. */
export interface CreateResourceInput {
  /** Stable, caller-chosen resource id (e.g. the slug). */
  readonly id: string;
  readonly tenantId: string;
  /** `model` | `workflow`. */
  readonly kind: string;
  /** `text` | `image` | `video` | `audio` | `composite`. */
  readonly modality: string;
  readonly providerType: string;
  readonly execModes: readonly string[];
  /** The frozen `io_schema` snapshot for this version (stored as jsonb). */
  readonly ioSchema: unknown;
  /** The version number to create; also written to `resource.current_version`. */
  readonly version: number;
}

/**
 * Create (or version-bump) a resource: writes the `resource` row with
 * `current_version = version` and the matching `resource_version` row carrying
 * the frozen `io_schema`, in a single transaction.
 *
 * When the `resource` already exists (a re-import) the row is updated to point
 * `current_version` at the new `version` and a fresh `resource_version` row is
 * inserted; the unique `resource_version_pk` guards against a duplicate
 * `(resource_id, version)`.
 */
export async function createResource(db: DbOrTx, input: CreateResourceInput): Promise<Resource> {
  return db.transaction(async (tx) => {
    const existing = await getResource(tx, input.id);

    let row: Resource | undefined;
    if (existing === undefined) {
      const inserted = await tx
        .insert(resource)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          kind: input.kind,
          modality: input.modality,
          providerType: input.providerType,
          execModes: [...input.execModes],
          currentVersion: input.version,
        })
        .returning();
      row = inserted[0];
    } else {
      const updated = await tx
        .update(resource)
        .set({ currentVersion: input.version })
        .where(eq(resource.id, input.id))
        .returning();
      row = updated[0];
    }
    if (!row) throw new Error('createResource: resource upsert returned no row');

    await tx.insert(resourceVersion).values({
      resourceId: input.id,
      version: input.version,
      ioSchema: input.ioSchema,
    });

    return row;
  });
}

/** Insert a `dify_binding` row. */
export async function createDifyBinding(
  db: DbOrTx,
  binding: InferInsertModel<typeof difyBinding>,
): Promise<DifyBindingRow> {
  const rows = await db.insert(difyBinding).values(binding).returning();
  const row = rows[0];
  if (!row) throw new Error('createDifyBinding: insert returned no row');
  return row;
}

/** A resource joined with the `io_schema` of its current version. */
export interface ResourceWithSchema extends Resource {
  /** The `io_schema` jsonb of the resource's `current_version`. */
  readonly ioSchema: unknown;
}

/**
 * Fetch a resource together with the `io_schema` of its `current_version`.
 * Returns `undefined` when the resource (or its current version row) is absent.
 */
export async function getResourceWithSchema(
  db: DbOrTx,
  resourceId: string,
): Promise<ResourceWithSchema | undefined> {
  const res = await getResource(db, resourceId);
  if (res === undefined) return undefined;

  const version = await getResourceVersion(db, resourceId, res.currentVersion);
  if (version === undefined) return undefined;

  return { ...res, ioSchema: version.ioSchema };
}

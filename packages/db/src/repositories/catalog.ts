import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

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
 * Fetch the dify binding for a resource, highest `resource_version` first (the
 * binding for the current version). Returns `undefined` when the resource has
 * no binding yet — used to detect a no-op re-import by `dsl_hash`.
 */
export async function getDifyBinding(
  db: DbOrTx,
  resourceId: string,
): Promise<DifyBindingRow | undefined> {
  const rows = await db
    .select()
    .from(difyBinding)
    .where(eq(difyBinding.resourceId, resourceId))
    .orderBy(desc(difyBinding.resourceVersion))
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
 * List EVERY active modifier, highest `priority` first (no scope filtering).
 *
 * Superseded on the run path by {@link listApplicableModifiers}, which restricts
 * the set to the scopes applicable to a specific `(tenant, resource)` run (§9.2).
 * Retained for callers/tests that intentionally want the unfiltered set.
 */
export async function listActiveModifiers(db: DbOrTx): Promise<ModifierRow[]> {
  return db
    .select()
    .from(modifier)
    .where(eq(modifier.active, true))
    .orderBy(desc(modifier.priority));
}

/** The `(tenantId, resourceId)` a modifier scope is resolved against. */
export interface ModifierScopeTarget {
  readonly tenantId: string;
  readonly resourceId: string;
}

/**
 * The scope strings that apply to a given run (§9.2). A modifier fires only
 * when its `scope` column matches one of these exactly:
 * - `global` — applies to every run.
 * - `tenant:<tenantId>` — applies to all of one tenant's runs.
 * - `capability:<resourceId>` / `resource:<resourceId>` — applies to one
 *   resource. (Capability and resource are the same anchor首期; both spellings
 *   are accepted so a modifier authored against either matches.)
 */
export function applicableScopes(target: ModifierScopeTarget): string[] {
  return [
    'global',
    `tenant:${target.tenantId}`,
    `capability:${target.resourceId}`,
    `resource:${target.resourceId}`,
  ];
}

/**
 * List the active modifiers whose `scope` applies to a specific run (§9.2),
 * highest `priority` first. Replaces {@link listActiveModifiers} on the run
 * path: a modifier is returned only when it is `active` AND its `scope` is one
 * of {@link applicableScopes} for the run's `(tenantId, resourceId)`. The
 * `whenExpr`/coupon evaluation remains a domain concern applied downstream.
 */
export async function listApplicableModifiers(
  db: DbOrTx,
  target: ModifierScopeTarget,
): Promise<ModifierRow[]> {
  return db
    .select()
    .from(modifier)
    .where(and(eq(modifier.active, true), inArray(modifier.scope, applicableScopes(target))))
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

/** The `resource` (+ `resource_version`) writes, run against an open handle. */
async function writeResource(tx: DbOrTx, input: CreateResourceInput): Promise<Resource> {
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
}

/**
 * Create (or version-bump) a resource: writes the `resource` row with
 * `current_version = version` and the matching `resource_version` row carrying
 * the frozen `io_schema`, atomically.
 *
 * When the `resource` already exists (a re-import) the row is updated to point
 * `current_version` at the new `version` and a fresh `resource_version` row is
 * inserted; the unique `resource_version_pk` guards against a duplicate
 * `(resource_id, version)`.
 *
 * Reuses an already-open transaction (`PgTransaction`) when one is passed so a
 * caller — e.g. dify registration writing the resource and its binding together
 * — gets a single flat transaction rather than a nested SAVEPOINT. When given
 * the root connection it opens its own transaction so the two writes stay
 * atomic on their own.
 */
export async function createResource(db: DbOrTx, input: CreateResourceInput): Promise<Resource> {
  // `isOpenTransaction` is a plain boolean (not a type guard) so `db` keeps its
  // schema-parameterized `DbOrTx` type rather than narrowing to the
  // unparameterized exported `PgTransaction` class.
  if (isOpenTransaction(db)) {
    return writeResource(db, input);
  }
  return db.transaction((tx) => writeResource(tx, input));
}

/** True when `db` is an already-open transaction (vs. the root connection). */
function isOpenTransaction(db: DbOrTx): boolean {
  return db instanceof PgTransaction;
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

/** List all resources, newest-first (admin catalog view). */
export async function listResources(db: DbOrTx): Promise<Resource[]> {
  return db.select().from(resource).orderBy(desc(resource.createdAt));
}

/**
 * Set a resource's `status` (e.g. `active` | `disabled`). Returns the updated
 * row, or `undefined` when the resource does not exist.
 */
export async function updateResourceStatus(
  db: DbOrTx,
  resourceId: string,
  status: string,
): Promise<Resource | undefined> {
  const rows = await db
    .update(resource)
    .set({ status })
    .where(eq(resource.id, resourceId))
    .returning();
  return rows[0];
}

/** Fields a caller supplies to {@link createUpstreamChannel}. */
export interface CreateUpstreamChannelInput {
  readonly resourceId: string;
  readonly providerType: string;
  /** Locator for the channel credential (uuid of a `secret_ref`), or null. */
  readonly credentialRef?: string | null | undefined;
  readonly weight?: number | undefined;
  readonly status?: string | undefined;
}

/** Insert an `upstream_channel` routing row for a resource. */
export async function createUpstreamChannel(
  db: DbOrTx,
  input: CreateUpstreamChannelInput,
): Promise<UpstreamChannelRow> {
  const rows = await db
    .insert(upstreamChannel)
    .values({
      resourceId: input.resourceId,
      providerType: input.providerType,
      credentialRef: input.credentialRef ?? null,
      weight: input.weight ?? 1,
      status: input.status ?? 'active',
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createUpstreamChannel: insert returned no row');
  return row;
}

/** Fields a caller supplies to {@link createPricebookEntry}. */
export interface CreatePricebookEntryInput {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly version: number;
  /** `unit` | `matrix` | `fixed` | `formula` | `passthrough`. */
  readonly method: string;
  /** `pre` | `post`. */
  readonly timing: string;
  /** The dimensions/table/amount/formula spec (stored as jsonb). */
  readonly spec: unknown;
  /** Optional markup spec (stored as jsonb). */
  readonly markup?: unknown;
  readonly active?: boolean | undefined;
}

/**
 * Insert a `pricebook_entry`. Any credit-denominated `amount` inside `spec`
 * MUST already be in µcredits (the controller converts human credits via
 * `creditsToMicro` before calling this repo).
 */
export async function createPricebookEntry(
  db: DbOrTx,
  input: CreatePricebookEntryInput,
): Promise<PricebookEntryRow> {
  const rows = await db
    .insert(pricebookEntry)
    .values({
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      version: input.version,
      method: input.method,
      timing: input.timing,
      spec: input.spec,
      markup: input.markup ?? null,
      active: input.active ?? true,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createPricebookEntry: insert returned no row');
  return row;
}

/** List pricebook entries for a resource, newest `version` first. */
export async function listPricebookEntries(
  db: DbOrTx,
  resourceId: string,
): Promise<PricebookEntryRow[]> {
  return db
    .select()
    .from(pricebookEntry)
    .where(eq(pricebookEntry.resourceId, resourceId))
    .orderBy(desc(pricebookEntry.version));
}

/** Fields a caller supplies to {@link createModifier}. */
export interface CreateModifierInput {
  /** `global` | `tenant:<id>` | `capability:<id>` | `resource:<id>` (§9.2). */
  readonly scope: string;
  readonly whenExpr?: string | null | undefined;
  /** `override_rate` | `percent_off` | `flat_off` | `percent_add`. */
  readonly op: string;
  /**
   * The modifier value. For `flat_off`/`override_rate` this is a µcredit amount
   * (the controller converts human credits via `creditsToMicro`); for the
   * percent ops it is a whole-percent integer.
   */
  readonly value?: bigint | null | undefined;
  readonly stackable?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly version?: number | undefined;
  readonly active?: boolean | undefined;
}

/** Insert a pricing `modifier` row. */
export async function createModifier(db: DbOrTx, input: CreateModifierInput): Promise<ModifierRow> {
  const rows = await db
    .insert(modifier)
    .values({
      scope: input.scope,
      whenExpr: input.whenExpr ?? null,
      op: input.op,
      value: input.value ?? null,
      stackable: input.stackable ?? true,
      priority: input.priority ?? 0,
      version: input.version ?? 1,
      active: input.active ?? true,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createModifier: insert returned no row');
  return row;
}

/** List all modifiers, highest `priority` first (admin view, incl. inactive). */
export async function listModifiers(db: DbOrTx): Promise<ModifierRow[]> {
  return db.select().from(modifier).orderBy(desc(modifier.priority));
}

import type { Markup, PriceSpec } from '@actionow/contracts';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';

import {
  account,
  channelHealth,
  difyBinding,
  modifier,
  pricebookEntry,
  resource,
  resourceVersion,
  secretRef,
  upstreamChannel,
} from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type Resource = InferSelectModel<typeof resource>;
export type SecretRefRow = InferSelectModel<typeof secretRef>;
export type ResourceVersionRow = InferSelectModel<typeof resourceVersion>;
export type PricebookEntryRow = InferSelectModel<typeof pricebookEntry>;
export type ModifierRow = InferSelectModel<typeof modifier>;
export type UpstreamChannelRow = InferSelectModel<typeof upstreamChannel>;
export type DifyBindingRow = InferSelectModel<typeof difyBinding>;

/** Fetch a live resource row by id (soft-deleted → `undefined`). */
export async function getResource(db: DbOrTx, resourceId: string): Promise<Resource | undefined> {
  const rows = await db
    .select()
    .from(resource)
    .where(and(eq(resource.id, resourceId), isNull(resource.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fetch a live resource by id scoped to a tenant (soft-deleted/other-tenant → `undefined`). */
export async function getResourceForTenant(
  db: DbOrTx,
  resourceId: string,
  tenantId: string,
): Promise<Resource | undefined> {
  const rows = await db
    .select()
    .from(resource)
    .where(
      and(eq(resource.id, resourceId), eq(resource.tenantId, tenantId), isNull(resource.deletedAt)),
    )
    .limit(1);
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
    .where(and(eq(difyBinding.resourceId, resourceId), isNull(difyBinding.deletedAt)))
    .orderBy(desc(difyBinding.resourceVersion))
    .limit(1);
  return rows[0];
}

/**
 * List live dify bindings (admin view; excludes soft-deleted), keyset-paginated
 * newest-first on `(created_at, resource_id)`. A dify resource has one live
 * binding (the current version), so `resource_id` is a stable keyset tiebreaker.
 */
export async function listDifyBindings(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<DifyBindingRow>> {
  return keysetPage<DifyBindingRow>(db, {
    table: difyBinding,
    createdAtCol: difyBinding.createdAt,
    idCol: difyBinding.resourceId,
    where: isNull(difyBinding.deletedAt),
    page,
  });
}

/** Mutable fields of a `dify_binding` (admin PATCH); omitted keys are unchanged. */
export interface UpdateDifyBindingInput {
  /** The dify app endpoint URL. */
  readonly endpoint?: string | undefined;
  /** A `secret_ref` id for the dify service key, or `null` to clear. */
  readonly serviceKeyRef?: string | null | undefined;
  /** `metered` | `fixed` | `matrix`. */
  readonly pricingModel?: string | undefined;
}

/**
 * Patch the CURRENT live dify binding for a resource (the highest
 * `resource_version`, mirroring {@link getDifyBinding}), returning the new row.
 * Only the supplied fields change. The `dify_binding` table has NO `updated_at`
 * column, so nothing is stamped. Soft-deleted / unknown → `undefined`; an empty
 * patch reads the current live binding back.
 */
export async function updateDifyBinding(
  db: DbOrTx,
  resourceId: string,
  patch: UpdateDifyBindingInput,
): Promise<DifyBindingRow | undefined> {
  const current = await getDifyBinding(db, resourceId);
  if (current === undefined) return undefined;
  const set: Partial<InferInsertModel<typeof difyBinding>> = {};
  if (patch.endpoint !== undefined) set.difyAppEndpoint = patch.endpoint;
  if (patch.serviceKeyRef !== undefined) set.difyServiceKeyRef = patch.serviceKeyRef;
  if (patch.pricingModel !== undefined) set.pricingModel = patch.pricingModel;
  if (Object.keys(set).length === 0) return current;
  const rows = await db
    .update(difyBinding)
    .set(set)
    .where(
      and(
        eq(difyBinding.resourceId, resourceId),
        eq(difyBinding.resourceVersion, current.resourceVersion),
        isNull(difyBinding.deletedAt),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Revoke a dify binding by SOFT-DELETING the CURRENT live binding for a resource
 * (the highest `resource_version`). `getDifyBinding` / `listDifyBindings` filter
 * `deleted_at IS NULL`, so the binding drops out of resolution + the listing. The
 * `dify_binding` table has no `updated_at`, so only `deleted_at` is set. Returns
 * the resource id, or `undefined` when nothing matched — idempotent.
 */
export async function softDeleteDifyBinding(
  db: DbOrTx,
  resourceId: string,
): Promise<string | undefined> {
  const current = await getDifyBinding(db, resourceId);
  if (current === undefined) return undefined;
  const rows = await db
    .update(difyBinding)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(difyBinding.resourceId, resourceId),
        eq(difyBinding.resourceVersion, current.resourceVersion),
        isNull(difyBinding.deletedAt),
      ),
    )
    .returning({ resourceId: difyBinding.resourceId });
  return rows[0]?.resourceId;
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
        isNull(pricebookEntry.deletedAt),
      ),
    )
    .orderBy(desc(pricebookEntry.version))
    .limit(1);
  return rows[0];
}

/**
 * Fetch a single live upstream channel by id, optionally scoped to a resource
 * (soft-deleted / wrong-resource → `undefined`). The `resourceId` predicate is
 * in SQL so a channel that belongs to another resource is indistinguishable from
 * a missing one — the admin nested route (`/resources/:id/channels/:channelId`)
 * passes it so a 404 covers both.
 */
export async function getChannelById(
  db: DbOrTx,
  channelId: string,
  resourceId?: string,
): Promise<UpstreamChannelRow | undefined> {
  const rows = await db
    .select()
    .from(upstreamChannel)
    .where(
      and(
        eq(upstreamChannel.id, channelId),
        isNull(upstreamChannel.deletedAt),
        resourceId !== undefined ? eq(upstreamChannel.resourceId, resourceId) : undefined,
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Revoke an upstream channel by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live AND (when given) belongs to
 * `resourceId`. `listChannels`/`listChannelsForResource`/`getChannelById` all
 * filter `deleted_at IS NULL`, so the channel drops out of routing + the operator
 * listing. Returns the deleted id, or `undefined` when nothing matched (not found
 * / wrong resource / already deleted) — idempotent.
 */
export async function softDeleteChannel(
  db: DbOrTx,
  channelId: string,
  resourceId?: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(upstreamChannel)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(upstreamChannel.id, channelId),
        isNull(upstreamChannel.deletedAt),
        resourceId !== undefined ? eq(upstreamChannel.resourceId, resourceId) : undefined,
      ),
    )
    .returning({ id: upstreamChannel.id });
  return rows[0]?.id;
}

/** List the active, live upstream channels for a resource (routing candidates). */
export async function listChannels(db: DbOrTx, resourceId: string): Promise<UpstreamChannelRow[]> {
  return db
    .select()
    .from(upstreamChannel)
    .where(
      and(
        eq(upstreamChannel.resourceId, resourceId),
        eq(upstreamChannel.status, 'active'),
        isNull(upstreamChannel.deletedAt),
      ),
    );
}

/**
 * List EVERY live upstream channel for a resource (incl. disabled) — operator
 * admin view — keyset-paginated newest-first on `(created_at, id)`.
 */
export async function listChannelsForResource(
  db: DbOrTx,
  resourceId: string,
  page: PageParams,
): Promise<KeysetResult<UpstreamChannelRow>> {
  return keysetPage<UpstreamChannelRow>(db, {
    table: upstreamChannel,
    createdAtCol: upstreamChannel.createdAt,
    idCol: upstreamChannel.id,
    where: and(eq(upstreamChannel.resourceId, resourceId), isNull(upstreamChannel.deletedAt)),
    page,
  });
}

/** Mutable fields of an `upstream_channel` (admin update); omitted keys are unchanged. */
export interface UpdateUpstreamChannelInput {
  readonly credentialRef?: string | null | undefined;
  readonly endpoint?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly proxyRef?: string | null | undefined;
  readonly config?: Record<string, unknown> | null | undefined;
  readonly weight?: number | undefined;
  readonly status?: string | undefined;
  /** Operator cost on this channel in µUSD/1M INPUT tokens (Track 5); `null` clears it. */
  readonly inputCostPer1m?: bigint | null | undefined;
  /** Operator cost on this channel in µUSD/1M OUTPUT tokens (Track 5); `null` clears it. */
  readonly outputCostPer1m?: bigint | null | undefined;
}

/** Patch an `upstream_channel` row (only the supplied fields), returning the new row. */
export async function updateUpstreamChannel(
  db: DbOrTx,
  channelId: string,
  patch: UpdateUpstreamChannelInput,
): Promise<UpstreamChannelRow | undefined> {
  const set: Partial<InferInsertModel<typeof upstreamChannel>> = {};
  if (patch.credentialRef !== undefined) set.credentialRef = patch.credentialRef;
  if (patch.endpoint !== undefined) set.endpoint = patch.endpoint;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.proxyRef !== undefined) set.proxyRef = patch.proxyRef;
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.weight !== undefined) set.weight = patch.weight;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.inputCostPer1m !== undefined) set.inputCostPer1m = patch.inputCostPer1m;
  if (patch.outputCostPer1m !== undefined) set.outputCostPer1m = patch.outputCostPer1m;
  if (Object.keys(set).length === 0) {
    const rows = await db
      .select()
      .from(upstreamChannel)
      .where(and(eq(upstreamChannel.id, channelId), isNull(upstreamChannel.deletedAt)))
      .limit(1);
    return rows[0];
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(upstreamChannel)
    .set(set)
    .where(and(eq(upstreamChannel.id, channelId), isNull(upstreamChannel.deletedAt)))
    .returning();
  return rows[0];
}

// --- Channel health / cooldown (P0a) -----------------------------------------

/** Exponential-backoff cooldown: base, cap, and the window after which the failure streak resets. */
const COOLDOWN_BASE_MS = 1_000;
const COOLDOWN_CAP_MS = 5 * 60_000;
const FAILURE_RESET_WINDOW_MS = 5 * 60_000;

/**
 * Record a routing failure for `channelId` and cool it down. The cooldown is
 * `now + min(BASE·2^(failures-1), CAP)` (or `retryAfterMs` if larger); the
 * failure streak resets to 1 when the prior failure is older than the reset
 * window, so no per-success write is needed — a channel is healthy once
 * `cooldown_until` passes. Best-effort: not transactional with the request.
 */
export async function recordChannelFailure(
  db: DbOrTx,
  channelId: string,
  now: Date,
  retryAfterMs?: number,
): Promise<void> {
  const existing = (
    await db.select().from(channelHealth).where(eq(channelHealth.channelId, channelId)).limit(1)
  )[0];
  const withinWindow =
    existing?.lastFailureAt != null &&
    now.getTime() - existing.lastFailureAt.getTime() < FAILURE_RESET_WINDOW_MS;
  const failures = withinWindow ? existing.consecutiveFailures + 1 : 1;
  const backoffMs = Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), COOLDOWN_CAP_MS);
  const cooldownUntil = new Date(now.getTime() + Math.max(backoffMs, retryAfterMs ?? 0));
  const values = {
    channelId,
    consecutiveFailures: failures,
    cooldownUntil,
    lastFailureAt: now,
    updatedAt: now,
  };
  await db
    .insert(channelHealth)
    .values(values)
    .onConflictDoUpdate({
      target: channelHealth.channelId,
      set: {
        consecutiveFailures: failures,
        cooldownUntil,
        lastFailureAt: now,
        updatedAt: now,
      },
    });
}

/**
 * Of the given `channelIds`, return those currently in cooldown (`cooldown_until
 * > now`). A channel with no health row, or whose cooldown has passed, is absent
 * (healthy). The router excludes the returned ids from selection.
 */
export async function listCooledDownChannelIds(
  db: DbOrTx,
  channelIds: string[],
  now: Date,
): Promise<string[]> {
  if (channelIds.length === 0) return [];
  const rows = await db
    .select({ channelId: channelHealth.channelId })
    .from(channelHealth)
    .where(and(inArray(channelHealth.channelId, channelIds), gt(channelHealth.cooldownUntil, now)));
  return rows.map((r) => r.channelId);
}

/** One non-deleted channel joined to its (optional) circuit-breaker health row. */
export interface ChannelHealthRow {
  channelId: string;
  resourceId: string;
  providerType: string;
  status: string;
  credentialRef: string | null;
  consecutiveFailures: number;
  cooldownUntil: Date | null;
  lastFailureAt: Date | null;
}

/**
 * List EVERY non-deleted `upstream_channel` left-joined to its `channel_health`
 * row (absent → healthy, surfaced as null cooldown / 0 failures). Powers the
 * read-only `GET /admin/health` ops snapshot; ordered by resource then channel.
 */
export async function listAllChannelsWithHealth(db: DbOrTx): Promise<ChannelHealthRow[]> {
  const rows = await db
    .select({
      channelId: upstreamChannel.id,
      resourceId: upstreamChannel.resourceId,
      providerType: upstreamChannel.providerType,
      status: upstreamChannel.status,
      credentialRef: upstreamChannel.credentialRef,
      consecutiveFailures: channelHealth.consecutiveFailures,
      cooldownUntil: channelHealth.cooldownUntil,
      lastFailureAt: channelHealth.lastFailureAt,
    })
    .from(upstreamChannel)
    .leftJoin(channelHealth, eq(channelHealth.channelId, upstreamChannel.id))
    .where(isNull(upstreamChannel.deletedAt))
    .orderBy(upstreamChannel.resourceId, upstreamChannel.id);
  return rows.map((r) => ({
    channelId: r.channelId,
    resourceId: r.resourceId,
    providerType: r.providerType,
    status: r.status,
    credentialRef: r.credentialRef,
    consecutiveFailures: r.consecutiveFailures ?? 0,
    cooldownUntil: r.cooldownUntil,
    lastFailureAt: r.lastFailureAt,
  }));
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
    .where(and(eq(modifier.active, true), isNull(modifier.deletedAt)))
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
    .where(
      and(
        eq(modifier.active, true),
        inArray(modifier.scope, applicableScopes(target)),
        isNull(modifier.deletedAt),
      ),
    )
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
    .where(and(eq(account.tenantId, tenantId), isNull(account.deletedAt)))
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
  // Existence probe is deletedAt-agnostic (unlike getResource): a re-import of a
  // soft-deleted resource must UPDATE the existing PK, not INSERT a conflicting row.
  const existingRows = await tx
    .select({ id: resource.id })
    .from(resource)
    .where(eq(resource.id, input.id))
    .limit(1);
  const existing = existingRows[0];

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

/**
 * List live resources newest-first (admin catalog view; excludes soft-deleted),
 * keyset-paginated on `(created_at, id)`. `resource.id` is a `text` slug and is
 * the keyset tiebreaker.
 */
export async function listResources(db: DbOrTx, page: PageParams): Promise<KeysetResult<Resource>> {
  return keysetPage<Resource>(db, {
    table: resource,
    createdAtCol: resource.createdAt,
    idCol: resource.id,
    where: isNull(resource.deletedAt),
    page,
  });
}

/** Count live resources (excludes soft-deleted) — authoritative total for the ops summary. */
export async function countResources(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(resource)
    .where(isNull(resource.deletedAt));
  return Number(rows[0]?.n ?? 0);
}

/**
 * List the resources visible to one tenant, newest-first. Used by the public
 * `GET /v1/resources` discovery endpoint (§4.5) so a caller only ever sees its
 * own tenant's catalog; the API-key `resourceAllowlist` is applied on top by the
 * controller.
 */
export async function listResourcesByTenant(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
  allowlist?: readonly string[],
): Promise<KeysetResult<Resource>> {
  // An optional `resourceAllowlist` (an API key's) narrows the set IN SQL so it
  // composes with the keyset — filtering after the fetch would break the
  // page-size/has_more invariant. An empty/omitted allowlist means no restriction.
  const restrict =
    allowlist !== undefined && allowlist.length > 0
      ? inArray(resource.id, [...allowlist])
      : undefined;
  return keysetPage<Resource>(db, {
    table: resource,
    createdAtCol: resource.createdAt,
    idCol: resource.id,
    where: and(eq(resource.tenantId, tenantId), isNull(resource.deletedAt), restrict),
    page,
  });
}

/**
 * Set a resource's `status` (e.g. `active` | `disabled`) and bump `updated_at`.
 * Returns the updated row, or `undefined` when the resource does not exist.
 */
export async function updateResourceStatus(
  db: DbOrTx,
  resourceId: string,
  status: string,
): Promise<Resource | undefined> {
  const rows = await db
    .update(resource)
    .set({ status, updatedAt: new Date() })
    .where(eq(resource.id, resourceId))
    .returning();
  return rows[0];
}

/**
 * Safe-field patch of a live `resource` (admin PATCH), bumping `updated_at`.
 * Limited to `status` ON PURPOSE — the key fields (`id`/`kind`/`modality`/
 * `provider_type`) are immutable here so a re-point can't silently corrupt the
 * routing/pricing a resource version froze. Soft-deleted / unknown → `undefined`;
 * an empty patch reads the current live row back.
 */
export async function updateResource(
  db: DbOrTx,
  resourceId: string,
  patch: { readonly status?: string | undefined },
): Promise<Resource | undefined> {
  if (patch.status === undefined) {
    return getResource(db, resourceId);
  }
  const rows = await db
    .update(resource)
    .set({ status: patch.status, updatedAt: new Date() })
    .where(and(eq(resource.id, resourceId), isNull(resource.deletedAt)))
    .returning();
  return rows[0];
}

/** Fetch a live `secret_ref` row by id (soft-deleted → `undefined`). */
export async function getSecretRef(db: DbOrTx, id: string): Promise<SecretRefRow | undefined> {
  const rows = await db
    .select()
    .from(secretRef)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Metadata-only view of a `secret_ref` — id/provider/locator/timestamps. NEVER
 * carries the secret material: for `enc` secrets the AES-GCM ciphertext lives in
 * the separate `secret_material` table (not selected here), and `env`/`oauth`
 * locators reference a value resolved at run time. Used by the admin
 * list/get-by-id surface so the operator never sees a credential value.
 */
export interface SecretRefView {
  readonly id: string;
  readonly provider: string;
  readonly locator: string;
  /** Operator-editable metadata (catalog redesign). */
  readonly name: string | null;
  readonly notes: string | null;
  readonly groupTag: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The metadata columns selected for a {@link SecretRefView} (no material). */
const SECRET_REF_VIEW_COLUMNS = {
  id: secretRef.id,
  provider: secretRef.provider,
  locator: secretRef.locator,
  name: secretRef.name,
  notes: secretRef.notes,
  groupTag: secretRef.groupTag,
  createdAt: secretRef.createdAt,
  updatedAt: secretRef.updatedAt,
} as const;

/**
 * Alias for {@link getSecretRef} that returns the metadata-only {@link SecretRefView}
 * (no material) for the admin `GET /admin/secrets/:id` route. Soft-deleted →
 * `undefined`. The full {@link getSecretRef} row carries no material either (the
 * ciphertext lives in `secret_material`), so this is purely a typed projection.
 */
export async function getSecretRefById(db: DbOrTx, id: string): Promise<SecretRefView | undefined> {
  const rows = await db
    .select(SECRET_REF_VIEW_COLUMNS)
    .from(secretRef)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * List live `secret_ref` rows (excludes soft-deleted), newest-first,
 * keyset-paginated on `(created_at, id)`. METADATA ONLY: the projection omits any
 * material — the `enc` ciphertext (in `secret_material`) is never joined — so the
 * secret value can never leave the service via this path.
 */
export async function listSecretRefs(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<SecretRefView>> {
  return keysetPage<SecretRefView>(db, {
    table: secretRef,
    createdAtCol: secretRef.createdAt,
    idCol: secretRef.id,
    selection: SECRET_REF_VIEW_COLUMNS,
    where: isNull(secretRef.deletedAt),
    page,
  });
}

/**
 * Revoke a `secret_ref` by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. Resolution fails afterwards because
 * {@link getSecretRef} filters `deleted_at IS NULL` (the `enc`/`env` branches of
 * {@link resolveSecretRef} both deref through it); the 1:1 `secret_material`
 * ciphertext is intentionally LEFT in place (orphaned but unreachable). Returns
 * the deleted id, or `undefined` when nothing matched (not found / already
 * revoked) — a second revoke is a safe no-op, never a throw.
 */
export async function softDeleteSecretRef(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(secretRef)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .returning({ id: secretRef.id });
  return rows[0]?.id;
}

/**
 * Update a `secret_ref`'s operator metadata (name/notes/group_tag) only — never the
 * material. Returns the updated id, or `undefined` if not found / soft-deleted. Each
 * present key is set (including explicit `null` to clear).
 */
export async function updateSecretRefMeta(
  db: DbOrTx,
  id: string,
  meta: {
    readonly name?: string | null | undefined;
    readonly notes?: string | null | undefined;
    readonly group?: string | null | undefined;
  },
): Promise<SecretRefView | undefined> {
  const set: Partial<InferInsertModel<typeof secretRef>> = { updatedAt: new Date() };
  if (meta.name !== undefined) set.name = meta.name;
  if (meta.notes !== undefined) set.notes = meta.notes;
  if (meta.group !== undefined) set.groupTag = meta.group;
  const rows = await db
    .update(secretRef)
    .set(set)
    .where(and(eq(secretRef.id, id), isNull(secretRef.deletedAt)))
    .returning(SECRET_REF_VIEW_COLUMNS);
  return rows[0];
}

/** Fields a caller supplies to {@link createSecretRef}. */
export interface CreateSecretRefInput {
  /** `env` | `vault` — where the secret is materialized from. */
  readonly provider: string;
  /** The locator within that provider (e.g. the env var name). */
  readonly locator: string;
}

/**
 * Insert a `secret_ref` row (a credential locator, never the secret itself) and
 * return it. The resolver materializes the value at run time from `provider` +
 * `locator`; only the locator is persisted.
 */
export async function createSecretRef(
  db: DbOrTx,
  input: CreateSecretRefInput,
): Promise<SecretRefRow> {
  const rows = await db
    .insert(secretRef)
    .values({ provider: input.provider, locator: input.locator })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSecretRef: insert returned no row');
  return row;
}

/** Fields a caller supplies to {@link createUpstreamChannel}. */
export interface CreateUpstreamChannelInput {
  readonly resourceId: string;
  readonly providerType: string;
  /** Locator for the channel credential (uuid of a `secret_ref`), or null. */
  readonly credentialRef?: string | null | undefined;
  /** Per-channel upstream base URL; null → adapter default. */
  readonly endpoint?: string | null | undefined;
  /** Per-channel model id; null → resource default. */
  readonly model?: string | null | undefined;
  /** Env-key locator for this channel's egress proxy URL; null → none. */
  readonly proxyRef?: string | null | undefined;
  /** Generic relay protocol config (submit/poll paths, signature header names); null → none. */
  readonly config?: Record<string, unknown> | null | undefined;
  readonly weight?: number | undefined;
  readonly status?: string | undefined;
  /** Operator cost on this channel in µUSD per 1M INPUT tokens (Track 5); null → unknown (0). */
  readonly inputCostPer1m?: bigint | null | undefined;
  /** Operator cost on this channel in µUSD per 1M OUTPUT tokens (Track 5); null → unknown (0). */
  readonly outputCostPer1m?: bigint | null | undefined;
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
      endpoint: input.endpoint ?? null,
      model: input.model ?? null,
      proxyRef: input.proxyRef ?? null,
      config: input.config ?? null,
      weight: input.weight ?? 1,
      status: input.status ?? 'active',
      inputCostPer1m: input.inputCostPer1m ?? null,
      outputCostPer1m: input.outputCostPer1m ?? null,
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
      // `spec`/`markup` are validated at the admin boundary; the columns are typed.
      spec: input.spec as PriceSpec,
      markup: (input.markup ?? null) as Markup | null,
      active: input.active ?? true,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createPricebookEntry: insert returned no row');
  return row;
}

/**
 * List a resource's pricebook entries, keyset-paginated newest-first on
 * `(created_at, id)`. The `resource_id` filter composes with the keyset.
 */
export async function listPricebookEntries(
  db: DbOrTx,
  resourceId: string,
  page: PageParams,
): Promise<KeysetResult<PricebookEntryRow>> {
  return keysetPage<PricebookEntryRow>(db, {
    table: pricebookEntry,
    createdAtCol: pricebookEntry.createdAt,
    idCol: pricebookEntry.id,
    where: and(eq(pricebookEntry.resourceId, resourceId), isNull(pricebookEntry.deletedAt)),
    page,
  });
}

/** Fetch a live pricebook entry by id (soft-deleted → `undefined`). */
export async function getPricebookEntryById(
  db: DbOrTx,
  id: string,
): Promise<PricebookEntryRow | undefined> {
  const rows = await db
    .select()
    .from(pricebookEntry)
    .where(and(eq(pricebookEntry.id, id), isNull(pricebookEntry.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable fields of a `pricebook_entry` (admin PATCH); omitted keys are unchanged. */
export interface UpdatePricebookEntryInput {
  readonly method?: string | undefined;
  readonly timing?: string | undefined;
  /** Any credit `amount` inside MUST already be µcredits (controller converts). */
  readonly spec?: unknown;
  readonly markup?: unknown;
  readonly active?: boolean | undefined;
}

/**
 * Patch a live `pricebook_entry` (only the supplied fields), bumping `updated_at`,
 * returning the new row. Like {@link createPricebookEntry}, any credit `amount`
 * inside `spec` MUST already be in µcredits — the controller converts a human
 * `fixedCredits` via `creditsToMicro` before calling this repo. Soft-deleted /
 * unknown → `undefined`; an empty patch reads the current live row back.
 */
export async function updatePricebookEntry(
  db: DbOrTx,
  id: string,
  patch: UpdatePricebookEntryInput,
): Promise<PricebookEntryRow | undefined> {
  const set: Partial<InferInsertModel<typeof pricebookEntry>> = {};
  if (patch.method !== undefined) set.method = patch.method;
  if (patch.timing !== undefined) set.timing = patch.timing;
  // `spec`/`markup` are validated at the admin boundary; the columns are typed.
  if (patch.spec !== undefined) set.spec = patch.spec as PriceSpec;
  if (patch.markup !== undefined) set.markup = patch.markup as Markup | null;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) {
    return getPricebookEntryById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(pricebookEntry)
    .set(set)
    .where(and(eq(pricebookEntry.id, id), isNull(pricebookEntry.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a pricebook entry by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. `getActivePricebookEntry` /
 * `listPricebookEntries` / `getPricebookEntryById` all filter `deleted_at IS
 * NULL`, so the entry stops pricing runs + drops from the listing. Returns the
 * deleted id, or `undefined` when nothing matched — idempotent.
 */
export async function softDeletePricebookEntry(
  db: DbOrTx,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(pricebookEntry)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(pricebookEntry.id, id), isNull(pricebookEntry.deletedAt)))
    .returning({ id: pricebookEntry.id });
  return rows[0]?.id;
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

/**
 * List live modifiers (admin view, incl. inactive), keyset-paginated newest-first
 * on `(created_at, id)`.
 */
export async function listModifiers(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<ModifierRow>> {
  return keysetPage<ModifierRow>(db, {
    table: modifier,
    createdAtCol: modifier.createdAt,
    idCol: modifier.id,
    where: isNull(modifier.deletedAt),
    page,
  });
}

/** Fetch a live modifier by id (soft-deleted → `undefined`). */
export async function getModifierById(db: DbOrTx, id: string): Promise<ModifierRow | undefined> {
  const rows = await db
    .select()
    .from(modifier)
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable fields of a `modifier` (admin PATCH); omitted keys are unchanged. */
export interface UpdateModifierInput {
  readonly whenExpr?: string | null | undefined;
  readonly op?: string | undefined;
  /**
   * The modifier value: a µcredit amount for credit ops (`flat_off`/
   * `override_rate`), a whole-percent int for percent ops. The controller
   * applies `creditsToMicro` for credit ops before calling this repo.
   */
  readonly value?: bigint | null | undefined;
  readonly stackable?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly active?: boolean | undefined;
}

/**
 * Patch a live `modifier` (only the supplied fields), bumping `updated_at`,
 * returning the new row. The `value` is stored verbatim — credit-denominated ops
 * arrive already converted to µcredits by the controller (mirroring
 * {@link createModifier}). Soft-deleted / unknown → `undefined`; an empty patch
 * reads the current live row back.
 */
export async function updateModifier(
  db: DbOrTx,
  id: string,
  patch: UpdateModifierInput,
): Promise<ModifierRow | undefined> {
  const set: Partial<InferInsertModel<typeof modifier>> = {};
  if (patch.whenExpr !== undefined) set.whenExpr = patch.whenExpr;
  if (patch.op !== undefined) set.op = patch.op;
  if (patch.value !== undefined) set.value = patch.value;
  if (patch.stackable !== undefined) set.stackable = patch.stackable;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.active !== undefined) set.active = patch.active;
  if (Object.keys(set).length === 0) {
    return getModifierById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(modifier)
    .set(set)
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a modifier by SOFT-DELETING it: stamps `deleted_at`/`updated_at`
 * (`now()`) only when the row is still live. `listActiveModifiers` /
 * `listApplicableModifiers` / `listModifiers` / `getModifierById` all filter
 * `deleted_at IS NULL`, so the modifier stops affecting pricing + drops from the
 * listing. Returns the deleted id, or `undefined` when nothing matched —
 * idempotent.
 */
export async function softDeleteModifier(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(modifier)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(modifier.id, id), isNull(modifier.deletedAt)))
    .returning({ id: modifier.id });
  return rows[0]?.id;
}

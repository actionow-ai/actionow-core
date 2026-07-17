import type {
  ArtifactPolicy,
  CredentialSecret,
  DialectRef,
  FetchProfile,
  ModelOperation,
  OfferingParamDecl,
  PriceSpec,
  QuotaMirror,
} from '@actionow/contracts';
import { credentialSecretSchema } from '@actionow/contracts';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
} from 'drizzle-orm';

import {
  apiKey,
  limitRule,
  supplyChannel,
  supplyCredential,
  supplyModel,
  supplyModelGrant,
  supplyOffering,
  supplyOfferingBreaker,
  supplyPriceCard,
  supplyProvider,
} from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import { createEncryptedSecret, resolveSecretRef } from './secret-resolver.js';
import type { DbOrTx } from './types.js';

// model-supply-greenfield 批次1 — functional repositories for the seven
// `supply_` tables (design §2). Conventions follow proxy.ts/model.ts: first
// param `DbOrTx`, `InferSelectModel` row types, live-only reads
// (`deleted_at IS NULL`), keyset pagination for lists, soft-delete everywhere
// except `supply_model_grant` (hard delete, mirroring the old model_grant).

export type SupplyPriceCardRow = InferSelectModel<typeof supplyPriceCard>;
export type SupplyProviderRow = InferSelectModel<typeof supplyProvider>;
export type SupplyChannelRow = InferSelectModel<typeof supplyChannel>;
export type SupplyCredentialRow = InferSelectModel<typeof supplyCredential>;
export type SupplyModelRow = InferSelectModel<typeof supplyModel>;
export type SupplyOfferingRow = InferSelectModel<typeof supplyOffering>;
export type SupplyModelGrantRow = InferSelectModel<typeof supplyModelGrant>;
export type SupplyOfferingBreakerRow = InferSelectModel<typeof supplyOfferingBreaker>;

// --- price_card (§2.7 / §9.2 — IMMUTABLE, versioned) -------------------------

/** Fields a caller supplies to {@link createSupplyPriceCard} (version defaults to 1). */
export interface CreateSupplyPriceCardInput {
  readonly name: string;
  /** One of the seven pricing methods; the API layer enforces `method === spec.method`. */
  readonly method: string;
  readonly unit: string;
  readonly tierDims?: string[] | undefined;
  readonly spec: PriceSpec;
  readonly currency?: string | undefined;
  /** Starting version of a fresh lineage (import/migration); omitted → 1. */
  readonly version?: number | undefined;
  readonly effectiveAt?: Date | undefined;
}

/** Insert a NEW price card at `version 1`. */
export async function createSupplyPriceCard(
  db: DbOrTx,
  input: CreateSupplyPriceCardInput,
): Promise<SupplyPriceCardRow> {
  const rows = await db
    .insert(supplyPriceCard)
    .values({
      name: input.name,
      method: input.method,
      unit: input.unit,
      spec: input.spec,
      ...(input.tierDims !== undefined ? { tierDims: input.tierDims } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyPriceCard: insert returned no row');
  return row;
}

/** Fetch a live price card by id (soft-deleted → `undefined`). */
export async function getSupplyPriceCardById(
  db: DbOrTx,
  id: string,
): Promise<SupplyPriceCardRow | undefined> {
  const rows = await db
    .select()
    .from(supplyPriceCard)
    .where(and(eq(supplyPriceCard.id, id), isNull(supplyPriceCard.deletedAt)))
    .limit(1);
  return rows[0];
}

/** List live price cards, newest-first, keyset-paginated. */
export function listSupplyPriceCards(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<SupplyPriceCardRow>> {
  return keysetPage<SupplyPriceCardRow>(db, {
    table: supplyPriceCard,
    createdAtCol: supplyPriceCard.createdAt,
    idCol: supplyPriceCard.id,
    where: isNull(supplyPriceCard.deletedAt),
    page,
  });
}

/** Overridable fields when minting a new version of an existing card. */
export interface SupplyPriceCardVersionPatch {
  readonly name?: string | undefined;
  readonly method?: string | undefined;
  readonly unit?: string | undefined;
  readonly tierDims?: string[] | undefined;
  readonly spec?: PriceSpec | undefined;
  readonly currency?: string | undefined;
  readonly effectiveAt?: Date | undefined;
}

/**
 * A price card is IMMUTABLE once effective — there is deliberately NO
 * `updateSupplyPriceCard`. A price change reads the live base card and INSERTS
 * a NEW row (new id) carrying the base fields overridden by `patch`, at
 * `version = base.version + 1`; the caller then RE-POINTS the referencing
 * model/offering. Billing events snapshot `{card_id, version}`, so history
 * stays reconstructable. Returns the new row, or `undefined` when the base
 * card is unknown / soft-deleted.
 */
export async function createSupplyPriceCardVersion(
  db: DbOrTx,
  id: string,
  patch: SupplyPriceCardVersionPatch = {},
): Promise<SupplyPriceCardRow | undefined> {
  const base = await getSupplyPriceCardById(db, id);
  if (base === undefined) return undefined;
  const rows = await db
    .insert(supplyPriceCard)
    .values({
      name: patch.name ?? base.name,
      method: patch.method ?? base.method,
      unit: patch.unit ?? base.unit,
      tierDims: patch.tierDims ?? base.tierDims,
      spec: patch.spec ?? base.spec,
      currency: patch.currency ?? base.currency,
      version: base.version + 1,
      ...(patch.effectiveAt !== undefined ? { effectiveAt: patch.effectiveAt } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyPriceCardVersion: insert returned no row');
  return row;
}

/** Soft-delete a price card (history stays for billing snapshots). Idempotent. */
export async function softDeleteSupplyPriceCard(
  db: DbOrTx,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyPriceCard)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyPriceCard.id, id), isNull(supplyPriceCard.deletedAt)))
    .returning({ id: supplyPriceCard.id });
  return rows[0]?.id;
}

// --- provider (§2.2) ----------------------------------------------------------

/** Fields a caller supplies to {@link createSupplyProvider}. */
export interface CreateSupplyProviderInput {
  readonly slug: string;
  readonly name: string;
  readonly icon?: string | null | undefined;
  readonly defaultDialect: DialectRef;
  readonly callbackVerification?: Record<string, unknown> | null | undefined;
  readonly defaultFaultPolicyId?: string | null | undefined;
  readonly region?: string | null | undefined;
}

/** Insert a `supply_provider` row and return it. */
export async function createSupplyProvider(
  db: DbOrTx,
  input: CreateSupplyProviderInput,
): Promise<SupplyProviderRow> {
  const rows = await db
    .insert(supplyProvider)
    .values({
      slug: input.slug,
      name: input.name,
      defaultDialect: input.defaultDialect,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.callbackVerification !== undefined
        ? { callbackVerification: input.callbackVerification }
        : {}),
      ...(input.defaultFaultPolicyId !== undefined
        ? { defaultFaultPolicyId: input.defaultFaultPolicyId }
        : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyProvider: insert returned no row');
  return row;
}

/** Fetch a live provider by id (soft-deleted → `undefined`). */
export async function getSupplyProviderById(
  db: DbOrTx,
  id: string,
): Promise<SupplyProviderRow | undefined> {
  const rows = await db
    .select()
    .from(supplyProvider)
    .where(and(eq(supplyProvider.id, id), isNull(supplyProvider.deletedAt)))
    .limit(1);
  return rows[0];
}

/** List live providers, newest-first, keyset-paginated. */
export function listSupplyProviders(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<SupplyProviderRow>> {
  return keysetPage<SupplyProviderRow>(db, {
    table: supplyProvider,
    createdAtCol: supplyProvider.createdAt,
    idCol: supplyProvider.id,
    where: isNull(supplyProvider.deletedAt),
    page,
  });
}

/** Mutable fields of a {@link supplyProvider} (admin PATCH). */
export interface UpdateSupplyProviderInput {
  readonly slug?: string | undefined;
  readonly name?: string | undefined;
  readonly icon?: string | null | undefined;
  readonly defaultDialect?: DialectRef | undefined;
  readonly callbackVerification?: Record<string, unknown> | null | undefined;
  readonly defaultFaultPolicyId?: string | null | undefined;
  readonly region?: string | null | undefined;
}

/** Patch a live provider; only supplied fields change. Soft-deleted / unknown → `undefined`. */
export async function updateSupplyProvider(
  db: DbOrTx,
  id: string,
  patch: UpdateSupplyProviderInput,
): Promise<SupplyProviderRow | undefined> {
  const set: Partial<InferInsertModel<typeof supplyProvider>> = {};
  if (patch.slug !== undefined) set.slug = patch.slug;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.defaultDialect !== undefined) set.defaultDialect = patch.defaultDialect;
  if (patch.callbackVerification !== undefined)
    set.callbackVerification = patch.callbackVerification;
  if (patch.defaultFaultPolicyId !== undefined)
    set.defaultFaultPolicyId = patch.defaultFaultPolicyId;
  if (patch.region !== undefined) set.region = patch.region;
  if (Object.keys(set).length === 0) return getSupplyProviderById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(supplyProvider)
    .set(set)
    .where(and(eq(supplyProvider.id, id), isNull(supplyProvider.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a provider (frees its slug for a fresh live row). Idempotent. */
export async function softDeleteSupplyProvider(
  db: DbOrTx,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyProvider)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyProvider.id, id), isNull(supplyProvider.deletedAt)))
    .returning({ id: supplyProvider.id });
  return rows[0]?.id;
}

// --- channel (§2.3) ------------------------------------------------------------

/** Fields a caller supplies to {@link createSupplyChannel}. */
export interface CreateSupplyChannelInput {
  readonly providerId: string;
  readonly name: string;
  readonly dialect?: DialectRef | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly proxyRef?: string | null | undefined;
  readonly region?: string | null | undefined;
  readonly authScheme: string;
  /** BYOK ownership: omitted/null = 平台自营. */
  readonly tenantId?: string | null | undefined;
  readonly routeGroupId?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly status?: string | undefined;
}

/** Insert a `supply_channel` row and return it. */
export async function createSupplyChannel(
  db: DbOrTx,
  input: CreateSupplyChannelInput,
): Promise<SupplyChannelRow> {
  const rows = await db
    .insert(supplyChannel)
    .values({
      providerId: input.providerId,
      name: input.name,
      authScheme: input.authScheme,
      ...(input.dialect !== undefined ? { dialect: input.dialect } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.proxyRef !== undefined ? { proxyRef: input.proxyRef } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.routeGroupId !== undefined ? { routeGroupId: input.routeGroupId } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyChannel: insert returned no row');
  return row;
}

/** Fetch a live channel by id (soft-deleted → `undefined`). */
export async function getSupplyChannelById(
  db: DbOrTx,
  id: string,
): Promise<SupplyChannelRow | undefined> {
  const rows = await db
    .select()
    .from(supplyChannel)
    .where(and(eq(supplyChannel.id, id), isNull(supplyChannel.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Optional filters for {@link listSupplyChannels}. */
export interface ListSupplyChannelsFilter {
  readonly providerId?: string | undefined;
  readonly tenantId?: string | undefined;
}

/** List live channels (optionally by provider / owning tenant), keyset-paginated. */
export function listSupplyChannels(
  db: DbOrTx,
  page: PageParams,
  filter: ListSupplyChannelsFilter = {},
): Promise<KeysetResult<SupplyChannelRow>> {
  const predicates: SQL[] = [];
  if (filter.providerId !== undefined)
    predicates.push(eq(supplyChannel.providerId, filter.providerId));
  if (filter.tenantId !== undefined) predicates.push(eq(supplyChannel.tenantId, filter.tenantId));
  return keysetPage<SupplyChannelRow>(db, {
    table: supplyChannel,
    createdAtCol: supplyChannel.createdAt,
    idCol: supplyChannel.id,
    where: and(isNull(supplyChannel.deletedAt), ...predicates),
    page,
  });
}

/** Mutable fields of a {@link supplyChannel} (admin PATCH). `provider_id` is immutable. */
export interface UpdateSupplyChannelInput {
  readonly name?: string | undefined;
  readonly dialect?: DialectRef | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly proxyRef?: string | null | undefined;
  readonly region?: string | null | undefined;
  readonly authScheme?: string | undefined;
  readonly tenantId?: string | null | undefined;
  readonly routeGroupId?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly status?: string | undefined;
}

/** Patch a live channel; only supplied fields change. Soft-deleted / unknown → `undefined`. */
export async function updateSupplyChannel(
  db: DbOrTx,
  id: string,
  patch: UpdateSupplyChannelInput,
): Promise<SupplyChannelRow | undefined> {
  const set: Partial<InferInsertModel<typeof supplyChannel>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.dialect !== undefined) set.dialect = patch.dialect;
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.proxyRef !== undefined) set.proxyRef = patch.proxyRef;
  if (patch.region !== undefined) set.region = patch.region;
  if (patch.authScheme !== undefined) set.authScheme = patch.authScheme;
  if (patch.tenantId !== undefined) set.tenantId = patch.tenantId;
  if (patch.routeGroupId !== undefined) set.routeGroupId = patch.routeGroupId;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) return getSupplyChannelById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(supplyChannel)
    .set(set)
    .where(and(eq(supplyChannel.id, id), isNull(supplyChannel.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a channel. Idempotent. */
export async function softDeleteSupplyChannel(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyChannel)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyChannel.id, id), isNull(supplyChannel.deletedAt)))
    .returning({ id: supplyChannel.id });
  return rows[0]?.id;
}

// --- credential (§2.4 — secret material lives in the vault) --------------------

/**
 * Redacted display hint for a structured secret: the last 4 chars of the
 * api_key / secret_key (e.g. `…f3a9`); `null` when the scheme carries neither
 * (oauth). The secret itself never leaves the vault.
 */
function secretHintFor(secret: CredentialSecret): string | null {
  const material =
    'api_key' in secret ? secret.api_key : 'secret_key' in secret ? secret.secret_key : undefined;
  if (material === undefined || material.length === 0) return null;
  return `…${material.slice(-4)}`;
}

/** Fields a caller supplies to {@link createSupplyCredential}. */
export interface CreateSupplyCredentialInput {
  readonly channelId: string;
  readonly name: string;
  /** The structured secret (shape = the channel's auth scheme); encrypted at rest, NEVER stored here. */
  readonly secret: CredentialSecret;
  /** Base64 AES-256 master key used to encrypt the secret. */
  readonly keyB64: string;
  readonly quota?: QuotaMirror | undefined;
}

/**
 * Create a credential: in ONE transaction, vault the structured secret
 * (`createEncryptedSecret` — AES-GCM `secret_ref` + material, AAD-bound) and
 * insert the `supply_credential` row pointing at it, with a redacted
 * `secret_hint` for display.
 */
export async function createSupplyCredential(
  db: DbOrTx,
  input: CreateSupplyCredentialInput,
): Promise<SupplyCredentialRow> {
  return db.transaction(async (tx) => {
    const ref = await createEncryptedSecret(tx, {
      value: JSON.stringify(input.secret),
      keyB64: input.keyB64,
    });
    const rows = await tx
      .insert(supplyCredential)
      .values({
        channelId: input.channelId,
        name: input.name,
        secretRefId: ref.id,
        secretHint: secretHintFor(input.secret),
        ...(input.quota !== undefined ? { quota: input.quota } : {}),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createSupplyCredential: insert returned no row');
    return row;
  });
}

/** Fetch a live credential by id (soft-deleted → `undefined`). */
export async function getSupplyCredentialById(
  db: DbOrTx,
  id: string,
): Promise<SupplyCredentialRow | undefined> {
  const rows = await db
    .select()
    .from(supplyCredential)
    .where(and(eq(supplyCredential.id, id), isNull(supplyCredential.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Decrypt a live credential's structured secret back into a
 * {@link CredentialSecret}: vault-resolve the `secret_ref`, `JSON.parse`, and
 * shape-check. Any failure (missing credential, unresolved ref, bad JSON,
 * shape mismatch) resolves to `undefined` — never a throw (vault convention).
 */
export async function resolveSupplyCredentialSecret(
  db: DbOrTx,
  credentialId: string,
): Promise<CredentialSecret | undefined> {
  const row = await getSupplyCredentialById(db, credentialId);
  if (row === undefined) return undefined;
  const raw = await resolveSecretRef(db, row.secretRefId);
  if (raw === undefined) return undefined;
  try {
    const parsed = credentialSecretSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Optional filters for {@link listSupplyCredentials}. */
export interface ListSupplyCredentialsFilter {
  readonly channelId?: string | undefined;
}

/** List live credentials (optionally by channel), keyset-paginated. */
export function listSupplyCredentials(
  db: DbOrTx,
  page: PageParams,
  filter: ListSupplyCredentialsFilter = {},
): Promise<KeysetResult<SupplyCredentialRow>> {
  const predicates: SQL[] = [];
  if (filter.channelId !== undefined)
    predicates.push(eq(supplyCredential.channelId, filter.channelId));
  return keysetPage<SupplyCredentialRow>(db, {
    table: supplyCredential,
    createdAtCol: supplyCredential.createdAt,
    idCol: supplyCredential.id,
    where: and(isNull(supplyCredential.deletedAt), ...predicates),
    page,
  });
}

/**
 * Mutable fields of a {@link supplyCredential} (admin PATCH + runtime
 * cooldown). Rotating the secret material is NOT an update — create a new
 * credential and retire this one.
 */
export interface UpdateSupplyCredentialInput {
  readonly name?: string | undefined;
  readonly quota?: QuotaMirror | undefined;
  readonly status?: string | undefined;
  /** `null` clears an active cooldown. */
  readonly cooldownUntil?: Date | null | undefined;
}

/** Patch a live credential; only supplied fields change. Soft-deleted / unknown → `undefined`. */
export async function updateSupplyCredential(
  db: DbOrTx,
  id: string,
  patch: UpdateSupplyCredentialInput,
): Promise<SupplyCredentialRow | undefined> {
  const set: Partial<InferInsertModel<typeof supplyCredential>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.quota !== undefined) set.quota = patch.quota;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.cooldownUntil !== undefined) set.cooldownUntil = patch.cooldownUntil;
  if (Object.keys(set).length === 0) return getSupplyCredentialById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(supplyCredential)
    .set(set)
    .where(and(eq(supplyCredential.id, id), isNull(supplyCredential.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a credential (drops it from the pool; the vault row stays for audit). Idempotent. */
export async function softDeleteSupplyCredential(
  db: DbOrTx,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyCredential)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyCredential.id, id), isNull(supplyCredential.deletedAt)))
    .returning({ id: supplyCredential.id });
  return rows[0]?.id;
}

// --- model (§2.1) ----------------------------------------------------------------

/** Fields a caller supplies to {@link createSupplyModel}. */
export interface CreateSupplyModelInput {
  readonly name: string;
  readonly displayName: string;
  readonly icon?: string | null | undefined;
  readonly status?: string | undefined;
  readonly modality: string;
  readonly operations: ModelOperation[];
  readonly capabilities?: string[] | undefined;
  readonly priceCardId?: string | null | undefined;
  readonly modifierGroupId?: string | null | undefined;
  readonly maxRunTimeSeconds?: number | null | undefined;
  readonly artifact?: ArtifactPolicy | undefined;
  readonly fallbackModelIds?: string[] | undefined;
  readonly limitPlanId?: string | null | undefined;
  readonly visibility?: string | undefined;
}

/** Insert a `supply_model` row and return it. */
export async function createSupplyModel(
  db: DbOrTx,
  input: CreateSupplyModelInput,
): Promise<SupplyModelRow> {
  const rows = await db
    .insert(supplyModel)
    .values({
      name: input.name,
      displayName: input.displayName,
      modality: input.modality,
      operations: input.operations,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(input.priceCardId !== undefined ? { priceCardId: input.priceCardId } : {}),
      ...(input.modifierGroupId !== undefined ? { modifierGroupId: input.modifierGroupId } : {}),
      ...(input.maxRunTimeSeconds !== undefined
        ? { maxRunTimeSeconds: input.maxRunTimeSeconds }
        : {}),
      ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
      ...(input.fallbackModelIds !== undefined ? { fallbackModelIds: input.fallbackModelIds } : {}),
      ...(input.limitPlanId !== undefined ? { limitPlanId: input.limitPlanId } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyModel: insert returned no row');
  return row;
}

/** Fetch a live model by id (soft-deleted → `undefined`). */
export async function getSupplyModelById(
  db: DbOrTx,
  id: string,
): Promise<SupplyModelRow | undefined> {
  const rows = await db
    .select()
    .from(supplyModel)
    .where(and(eq(supplyModel.id, id), isNull(supplyModel.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Optional filters for {@link listSupplyModels}. */
export interface ListSupplyModelsFilter {
  readonly status?: string | undefined;
}

/** List live models (optionally by status), keyset-paginated. */
export function listSupplyModels(
  db: DbOrTx,
  page: PageParams,
  filter: ListSupplyModelsFilter = {},
): Promise<KeysetResult<SupplyModelRow>> {
  const predicates: SQL[] = [];
  if (filter.status !== undefined) predicates.push(eq(supplyModel.status, filter.status));
  return keysetPage<SupplyModelRow>(db, {
    table: supplyModel,
    createdAtCol: supplyModel.createdAt,
    idCol: supplyModel.id,
    where: and(isNull(supplyModel.deletedAt), ...predicates),
    page,
  });
}

/** Mutable fields of a {@link supplyModel} (admin PATCH). */
export interface UpdateSupplyModelInput {
  readonly name?: string | undefined;
  readonly displayName?: string | undefined;
  readonly icon?: string | null | undefined;
  readonly status?: string | undefined;
  readonly modality?: string | undefined;
  readonly operations?: ModelOperation[] | undefined;
  readonly capabilities?: string[] | undefined;
  readonly priceCardId?: string | null | undefined;
  readonly modifierGroupId?: string | null | undefined;
  readonly maxRunTimeSeconds?: number | null | undefined;
  readonly artifact?: ArtifactPolicy | undefined;
  readonly fallbackModelIds?: string[] | undefined;
  readonly limitPlanId?: string | null | undefined;
  readonly visibility?: string | undefined;
}

/** Patch a live model; only supplied fields change. Soft-deleted / unknown → `undefined`. */
export async function updateSupplyModel(
  db: DbOrTx,
  id: string,
  patch: UpdateSupplyModelInput,
): Promise<SupplyModelRow | undefined> {
  const set: Partial<InferInsertModel<typeof supplyModel>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.modality !== undefined) set.modality = patch.modality;
  if (patch.operations !== undefined) set.operations = patch.operations;
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
  if (patch.priceCardId !== undefined) set.priceCardId = patch.priceCardId;
  if (patch.modifierGroupId !== undefined) set.modifierGroupId = patch.modifierGroupId;
  if (patch.maxRunTimeSeconds !== undefined) set.maxRunTimeSeconds = patch.maxRunTimeSeconds;
  if (patch.artifact !== undefined) set.artifact = patch.artifact;
  if (patch.fallbackModelIds !== undefined) set.fallbackModelIds = patch.fallbackModelIds;
  if (patch.limitPlanId !== undefined) set.limitPlanId = patch.limitPlanId;
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (Object.keys(set).length === 0) return getSupplyModelById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(supplyModel)
    .set(set)
    .where(and(eq(supplyModel.id, id), isNull(supplyModel.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete a model (frees its external name for a fresh live row). Idempotent. */
export async function softDeleteSupplyModel(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyModel)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyModel.id, id), isNull(supplyModel.deletedAt)))
    .returning({ id: supplyModel.id });
  return rows[0]?.id;
}

// --- offering (§2.5) ----------------------------------------------------------------

/** Fields a caller supplies to {@link createSupplyOffering}. */
export interface CreateSupplyOfferingInput {
  readonly modelId: string;
  readonly channelId: string;
  readonly status?: string | undefined;
  readonly upstreamModelName: string;
  readonly fetchProfile: FetchProfile;
  readonly timeoutBudgetSeconds?: number | null | undefined;
  readonly paramDeclarations?: OfferingParamDecl[] | undefined;
  readonly costPriceCardId?: string | null | undefined;
  readonly maxConcurrency?: number | null | undefined;
  readonly weight?: number | undefined;
  readonly tier?: number | undefined;
}

/** Insert a `supply_offering` row and return it (partial-unique on live (model, channel)). */
export async function createSupplyOffering(
  db: DbOrTx,
  input: CreateSupplyOfferingInput,
): Promise<SupplyOfferingRow> {
  const rows = await db
    .insert(supplyOffering)
    .values({
      modelId: input.modelId,
      channelId: input.channelId,
      upstreamModelName: input.upstreamModelName,
      fetchProfile: input.fetchProfile,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.timeoutBudgetSeconds !== undefined
        ? { timeoutBudgetSeconds: input.timeoutBudgetSeconds }
        : {}),
      ...(input.paramDeclarations !== undefined
        ? { paramDeclarations: input.paramDeclarations }
        : {}),
      ...(input.costPriceCardId !== undefined ? { costPriceCardId: input.costPriceCardId } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSupplyOffering: insert returned no row');
  return row;
}

/** Fetch a live offering by id (soft-deleted → `undefined`). */
export async function getSupplyOfferingById(
  db: DbOrTx,
  id: string,
): Promise<SupplyOfferingRow | undefined> {
  const rows = await db
    .select()
    .from(supplyOffering)
    .where(and(eq(supplyOffering.id, id), isNull(supplyOffering.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Optional filters for {@link listSupplyOfferings}. */
export interface ListSupplyOfferingsFilter {
  readonly modelId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly status?: string | undefined;
}

/** List live offerings (optionally by model / channel / status), keyset-paginated. */
export function listSupplyOfferings(
  db: DbOrTx,
  page: PageParams,
  filter: ListSupplyOfferingsFilter = {},
): Promise<KeysetResult<SupplyOfferingRow>> {
  const predicates: SQL[] = [];
  if (filter.modelId !== undefined) predicates.push(eq(supplyOffering.modelId, filter.modelId));
  if (filter.channelId !== undefined)
    predicates.push(eq(supplyOffering.channelId, filter.channelId));
  if (filter.status !== undefined) predicates.push(eq(supplyOffering.status, filter.status));
  return keysetPage<SupplyOfferingRow>(db, {
    table: supplyOffering,
    createdAtCol: supplyOffering.createdAt,
    idCol: supplyOffering.id,
    where: and(isNull(supplyOffering.deletedAt), ...predicates),
    page,
  });
}

/**
 * Mutable fields of a {@link supplyOffering} (admin PATCH). The (model,
 * channel) pair is the offering's IDENTITY — never updatable; re-binding is a
 * new offering.
 */
export interface UpdateSupplyOfferingInput {
  readonly status?: string | undefined;
  readonly upstreamModelName?: string | undefined;
  readonly fetchProfile?: FetchProfile | undefined;
  readonly timeoutBudgetSeconds?: number | null | undefined;
  readonly paramDeclarations?: OfferingParamDecl[] | undefined;
  readonly costPriceCardId?: string | null | undefined;
  readonly maxConcurrency?: number | null | undefined;
  readonly weight?: number | undefined;
  readonly tier?: number | undefined;
}

/** Patch a live offering; only supplied fields change. Soft-deleted / unknown → `undefined`. */
export async function updateSupplyOffering(
  db: DbOrTx,
  id: string,
  patch: UpdateSupplyOfferingInput,
): Promise<SupplyOfferingRow | undefined> {
  const set: Partial<InferInsertModel<typeof supplyOffering>> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.upstreamModelName !== undefined) set.upstreamModelName = patch.upstreamModelName;
  if (patch.fetchProfile !== undefined) set.fetchProfile = patch.fetchProfile;
  if (patch.timeoutBudgetSeconds !== undefined)
    set.timeoutBudgetSeconds = patch.timeoutBudgetSeconds;
  if (patch.paramDeclarations !== undefined) set.paramDeclarations = patch.paramDeclarations;
  if (patch.costPriceCardId !== undefined) set.costPriceCardId = patch.costPriceCardId;
  if (patch.maxConcurrency !== undefined) set.maxConcurrency = patch.maxConcurrency;
  if (patch.weight !== undefined) set.weight = patch.weight;
  if (patch.tier !== undefined) set.tier = patch.tier;
  if (Object.keys(set).length === 0) return getSupplyOfferingById(db, id);
  set.updatedAt = new Date();
  const rows = await db
    .update(supplyOffering)
    .set(set)
    .where(and(eq(supplyOffering.id, id), isNull(supplyOffering.deletedAt)))
    .returning();
  return rows[0];
}

/** Soft-delete an offering (frees its (model, channel) slot). Idempotent. */
export async function softDeleteSupplyOffering(
  db: DbOrTx,
  id: string,
): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(supplyOffering)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(supplyOffering.id, id), isNull(supplyOffering.deletedAt)))
    .returning({ id: supplyOffering.id });
  return rows[0]?.id;
}

// --- model_grant (§2.1 visibility gate — hard-deleted) --------------------------

/** Grant a `granted`-visibility model to a tenant. Idempotent on `(model_id, tenant_id)`. */
export async function grantSupplyModel(
  db: DbOrTx,
  modelId: string,
  tenantId: string,
): Promise<void> {
  await db
    .insert(supplyModelGrant)
    .values({ modelId, tenantId })
    .onConflictDoNothing({ target: [supplyModelGrant.modelId, supplyModelGrant.tenantId] });
}

/**
 * Revoke a tenant's grant: a TRUE hard DELETE (`supply_model_grant` has no
 * soft-delete). Returns the deleted grant id, or `undefined` when no such
 * grant existed — idempotent.
 */
export async function revokeSupplyModel(
  db: DbOrTx,
  modelId: string,
  tenantId: string,
): Promise<string | undefined> {
  const rows = await db
    .delete(supplyModelGrant)
    .where(and(eq(supplyModelGrant.modelId, modelId), eq(supplyModelGrant.tenantId, tenantId)))
    .returning({ id: supplyModelGrant.id });
  return rows[0]?.id;
}

/** List a model's tenant grants, newest-first, keyset-paginated. */
export function listSupplyModelGrants(
  db: DbOrTx,
  modelId: string,
  page: PageParams,
): Promise<KeysetResult<SupplyModelGrantRow>> {
  return keysetPage<SupplyModelGrantRow>(db, {
    table: supplyModelGrant,
    createdAtCol: supplyModelGrant.createdAt,
    idCol: supplyModelGrant.id,
    where: eq(supplyModelGrant.modelId, modelId),
    page,
  });
}

// --- tenant visibility & BYOK routability gates (§2.1 / §2.3 — 判据 2.1) ---------

/**
 * The ON-SHELF model statuses (§10 下线语义): `deprecated` stays servable and
 * listed (批次3 adds the response-header 预告 / catalog marker); `draft` never
 * left the backstage and `disabled` is a hard 404 `model_not_found`.
 */
const SERVABLE_SUPPLY_MODEL_STATUSES = ['active', 'deprecated'];

/**
 * List the supply models VISIBLE to `tenantId` (§2.1 租户维度 — the new-world
 * discovery face): every live on-shelf `public` model, plus every live
 * on-shelf `granted` model this tenant holds a `supply_model_grant` for.
 * Mirrors the old-world `listVisibleModels` gate: the WHOLE visibility
 * predicate is in the SQL WHERE/JOIN (`public` OR a tenant-scoped grant join
 * hit) — never fetch-all-then-filter. The grant join cannot fan out: it is
 * pinned to ONE tenant and `(model_id, tenant_id)` is unique.
 */
export async function listVisibleSupplyModels(
  db: DbOrTx,
  tenantId: string,
): Promise<SupplyModelRow[]> {
  return db
    .select(getTableColumns(supplyModel))
    .from(supplyModel)
    .leftJoin(
      supplyModelGrant,
      and(eq(supplyModelGrant.modelId, supplyModel.id), eq(supplyModelGrant.tenantId, tenantId)),
    )
    .where(
      and(
        inArray(supplyModel.status, SERVABLE_SUPPLY_MODEL_STATUSES),
        isNull(supplyModel.deletedAt),
        or(eq(supplyModel.visibility, 'public'), isNotNull(supplyModelGrant.tenantId)),
      ),
    )
    .orderBy(desc(supplyModel.createdAt), desc(supplyModel.id));
}

/**
 * Resolve a supply model by its external `name` for `tenantId` — the
 * new-world twin of `resolveModelForTenant` (§2.1 visibility gate, consumed by
 * the 批次3 router as its entry lookup). Returns the row when the model is
 * live, on-shelf (`active` | `deprecated` — the row carries `status` so the
 * caller can attach the §10 deprecation header), and either `public` or
 * `granted`-WITH-a-grant for this tenant; otherwise `undefined` — an ungranted
 * model is indistinguishable from a missing one. The tenant predicate lives in
 * the SQL JOIN/WHERE, never a read-then-check.
 */
export async function resolveSupplyModelByNameForTenant(
  db: DbOrTx,
  name: string,
  tenantId: string,
): Promise<SupplyModelRow | undefined> {
  const rows = await db
    .select(getTableColumns(supplyModel))
    .from(supplyModel)
    .leftJoin(
      supplyModelGrant,
      and(eq(supplyModelGrant.modelId, supplyModel.id), eq(supplyModelGrant.tenantId, tenantId)),
    )
    .where(
      and(
        eq(supplyModel.name, name),
        inArray(supplyModel.status, SERVABLE_SUPPLY_MODEL_STATUSES),
        isNull(supplyModel.deletedAt),
        or(eq(supplyModel.visibility, 'public'), isNotNull(supplyModelGrant.tenantId)),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The §9.1 模型全局闸 cap for one external model name (批次6 D3 — the old
 * `model.rate_limit` column died with the `model` table; this re-sources the
 * gate from the NEW world): the model's bound `limit_plan` (对外限额,
 * `supply_model.limit_plan_id`) is read and its `rpm`-dimension rules are
 * reduced to the TIGHTEST cap that applies to this model (`model_scope` null =
 * plan-wide, or an exact name match). `null` = no gate configured (no live
 * model / no plan binding / no rpm rule) — exactly the old "rate_limit NULL"
 * semantics the gate treats as pass-through.
 */
export async function getSupplyModelRateLimit(db: DbOrTx, name: string): Promise<number | null> {
  const rows = await db
    .select({ limitPlanId: supplyModel.limitPlanId })
    .from(supplyModel)
    .where(and(eq(supplyModel.name, name), isNull(supplyModel.deletedAt)))
    .limit(1);
  const planId = rows[0]?.limitPlanId ?? null;
  if (planId === null) return null;
  const rules = await db.select().from(limitRule).where(eq(limitRule.planId, planId));
  const caps = rules
    .filter((r) => r.dimension === 'rpm' && (r.modelScope === null || r.modelScope === name))
    .map((r) => Number(r.cap));
  if (caps.length === 0) return null;
  return Math.min(...caps);
}

/** An offering the calling tenant may route to, plus the channel-ownership facts. */
export interface RoutableSupplyOffering extends SupplyOfferingRow {
  /** The channel's BYOK owner: `null` = 平台自营; a uuid = that tenant's private channel (§2.3). */
  readonly channelTenantId: string | null;
  /** The channel's provider (brand) — routing/observability context for 批次3. */
  readonly channelProviderId: string;
}

/** Params for {@link listRoutableSupplyOfferings}. */
export interface ListRoutableSupplyOfferingsParams {
  readonly modelId: string;
  /** The CALLING tenant — the BYOK ownership gate is evaluated against it. */
  readonly tenantId: string;
}

/**
 * The §2.3 BYOK routability gate: the offerings of `modelId` that `tenantId`
 * may route to — `status: 'enabled'` offerings (hard principle #4 — the ONLY
 * routable state) whose live `active` channel is either platform-operated
 * (`channel.tenant_id IS NULL`) or owned by THIS tenant. An offering born from
 * another tenant's private channel NEVER surfaces here; the ownership
 * predicate is in the SQL WHERE (never post-filtered). Rows come back tier
 * DESC (§8's primary sort; same-tier weight randomization is the 批次3
 * router's job) with the channel ownership fields for candidate bookkeeping.
 */
export async function listRoutableSupplyOfferings(
  db: DbOrTx,
  params: ListRoutableSupplyOfferingsParams,
): Promise<RoutableSupplyOffering[]> {
  return db
    .select({
      ...getTableColumns(supplyOffering),
      channelTenantId: supplyChannel.tenantId,
      channelProviderId: supplyChannel.providerId,
    })
    .from(supplyOffering)
    .innerJoin(supplyChannel, eq(supplyOffering.channelId, supplyChannel.id))
    .where(
      and(
        eq(supplyOffering.modelId, params.modelId),
        eq(supplyOffering.status, 'enabled'),
        isNull(supplyOffering.deletedAt),
        eq(supplyChannel.status, 'active'),
        isNull(supplyChannel.deletedAt),
        or(isNull(supplyChannel.tenantId), eq(supplyChannel.tenantId, params.tenantId)),
      ),
    )
    .orderBy(desc(supplyOffering.tier), desc(supplyOffering.createdAt), desc(supplyOffering.id));
}

// --- planner routing queries (批次3 §8 候选装配一站式取数) ----------------------

/** The channel routing dimensions a planner candidate carries. */
export type RoutingCandidateChannel = Pick<
  SupplyChannelRow,
  | 'id'
  | 'tenantId'
  | 'providerId'
  | 'tags'
  | 'routeGroupId'
  | 'dialect'
  | 'baseUrl'
  | 'proxyRef'
  | 'authScheme'
  | 'region'
  | 'status'
>;

/**
 * A routable offering PLUS its channel's routing dimensions — the one-stop
 * candidate row the 批次3 planner assembles from (§8).
 */
export interface RoutingCandidate extends SupplyOfferingRow {
  readonly channel: RoutingCandidateChannel;
}

/** Params for {@link listRoutingCandidates}. */
export interface ListRoutingCandidatesParams {
  readonly modelId: string;
  /** The CALLING tenant — the §2.3 BYOK ownership gate is evaluated against it. */
  readonly tenantId: string;
  /**
   * §route-tagging narrow-only pin: keep ONLY channels whose `tags` contain
   * this tag. Zero matches → empty result; the 400 on an empty pin is the
   * planner's job (slice 3), never this query's.
   */
  readonly routeTag?: string | undefined;
  /** Narrow to channels bound to this route group. */
  readonly routeGroupId?: string | undefined;
}

/**
 * The SUPERSET of {@link listRoutableSupplyOfferings} the planner consumes:
 * same gates (`enabled` offering × live `active` channel × BYOK ownership —
 * hard principle #4, ownership in the SQL WHERE, never post-filtered) plus the
 * channel's routing dimensions inline and the optional route-tag /
 * route-group narrowing. Rows come back tier DESC (§8 primary sort; same-tier
 * weight randomization is the planner's job), then created_at/id DESC.
 */
export async function listRoutingCandidates(
  db: DbOrTx,
  params: ListRoutingCandidatesParams,
): Promise<RoutingCandidate[]> {
  const predicates: SQL[] = [];
  if (params.routeTag !== undefined)
    predicates.push(arrayContains(supplyChannel.tags, [params.routeTag]));
  if (params.routeGroupId !== undefined)
    predicates.push(eq(supplyChannel.routeGroupId, params.routeGroupId));
  return db
    .select({
      ...getTableColumns(supplyOffering),
      channel: {
        id: supplyChannel.id,
        tenantId: supplyChannel.tenantId,
        providerId: supplyChannel.providerId,
        tags: supplyChannel.tags,
        routeGroupId: supplyChannel.routeGroupId,
        dialect: supplyChannel.dialect,
        baseUrl: supplyChannel.baseUrl,
        proxyRef: supplyChannel.proxyRef,
        authScheme: supplyChannel.authScheme,
        region: supplyChannel.region,
        status: supplyChannel.status,
      },
    })
    .from(supplyOffering)
    .innerJoin(supplyChannel, eq(supplyOffering.channelId, supplyChannel.id))
    .where(
      and(
        eq(supplyOffering.modelId, params.modelId),
        eq(supplyOffering.status, 'enabled'),
        isNull(supplyOffering.deletedAt),
        eq(supplyChannel.status, 'active'),
        isNull(supplyChannel.deletedAt),
        or(isNull(supplyChannel.tenantId), eq(supplyChannel.tenantId, params.tenantId)),
        ...predicates,
      ),
    )
    .orderBy(desc(supplyOffering.tier), desc(supplyOffering.createdAt), desc(supplyOffering.id));
}

/**
 * A channel's USABLE key pool right now (§2.4 / §7.8): live `active`
 * credentials not in cooldown (`cooldown_until` null or already elapsed at
 * `now`). Ordered created_at ASC so in-pool rotation is deterministic. Rows
 * carry `quota` (the upstream mirror) for the §7.8 concurrency clamp.
 */
export async function listActiveCredentialsForChannel(
  db: DbOrTx,
  channelId: string,
  now: Date,
): Promise<SupplyCredentialRow[]> {
  return db
    .select()
    .from(supplyCredential)
    .where(
      and(
        eq(supplyCredential.channelId, channelId),
        isNull(supplyCredential.deletedAt),
        eq(supplyCredential.status, 'active'),
        or(isNull(supplyCredential.cooldownUntil), lt(supplyCredential.cooldownUntil, now)),
      ),
    )
    .orderBy(asc(supplyCredential.createdAt));
}

/**
 * Batch-fetch live price cards by id → `Map<id, row>` (soft-deleted / unknown
 * ids simply absent; `[]` → empty Map). The planner pulls a candidate set's
 * SALE + COST cards in ONE round-trip instead of per-offering lookups.
 */
export async function getSupplyPriceCardsByIds(
  db: DbOrTx,
  ids: string[],
): Promise<Map<string, SupplyPriceCardRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(supplyPriceCard)
    .where(and(inArray(supplyPriceCard.id, ids), isNull(supplyPriceCard.deletedAt)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Batch-fetch price cards by id INCLUDING soft-deleted rows → `Map<id, row>`.
 * §2.7 settle-time snapshot rebuild (批次4 slice2): a card referenced by a
 * hold-time snapshot `{card_id, version}` must re-price EXACTLY even when the
 * card was soft-deleted between hold and settle — card rows are immutable
 * (version = that id's version), and a soft delete only closes the card to
 * NEW admissions. The live-only variant above is for admission-time reads;
 * this one is for snapshot reconstruction. Ids that never existed are simply
 * absent from the Map.
 */
export async function getSupplyPriceCardsByIdsIncludingDeleted(
  db: DbOrTx,
  ids: string[],
): Promise<Map<string, SupplyPriceCardRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(supplyPriceCard).where(inArray(supplyPriceCard.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

// --- offering breaker runtime state (批次3 — per-offering FSM persistence) -------

/**
 * Batch-read breaker rows for a candidate set → `Map<offering_id, row>` (`[]`
 * → empty Map). A MISSING offering is in the `closed` initial state — the
 * planner defaults it; this repo never fabricates rows. State DECISIONS live
 * in the pure engine FSM (breaker.ts); this layer only reads/writes.
 */
export async function getSupplyOfferingBreakers(
  db: DbOrTx,
  offeringIds: string[],
): Promise<Map<string, SupplyOfferingBreakerRow>> {
  if (offeringIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(supplyOfferingBreaker)
    .where(inArray(supplyOfferingBreaker.offeringId, offeringIds));
  return new Map(rows.map((row) => [row.offeringId, row]));
}

/**
 * The FULL breaker snapshot an upsert persists — the engine FSM emits complete
 * next-states, so writes are whole-row (runtime table, HARD overwrite).
 */
export interface SupplyOfferingBreakerSnapshotInput {
  readonly state: 'closed' | 'open' | 'half_open';
  readonly openedAt: Date | null;
  readonly halfOpenSuccesses: number;
  readonly consecutiveOpens: number;
}

/**
 * Persist an offering's breaker snapshot: INSERT the first transition,
 * hard-OVERWRITE thereafter (`onConflictDoUpdate` on the offering_id PK).
 * No FSM logic here — the caller (slice 3 orchestration) computes `snapshot`
 * via the pure breaker.ts transitions and this function only lands it.
 */
export async function upsertSupplyOfferingBreaker(
  db: DbOrTx,
  offeringId: string,
  snapshot: SupplyOfferingBreakerSnapshotInput,
): Promise<SupplyOfferingBreakerRow> {
  const now = new Date();
  const rows = await db
    .insert(supplyOfferingBreaker)
    .values({
      offeringId,
      state: snapshot.state,
      openedAt: snapshot.openedAt,
      halfOpenSuccesses: snapshot.halfOpenSuccesses,
      consecutiveOpens: snapshot.consecutiveOpens,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: supplyOfferingBreaker.offeringId,
      set: {
        state: snapshot.state,
        openedAt: snapshot.openedAt,
        halfOpenSuccesses: snapshot.halfOpenSuccesses,
        consecutiveOpens: snapshot.consecutiveOpens,
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertSupplyOfferingBreaker: upsert returned no row');
  return row;
}

// --- api_key model allowlist (§2.6) ---------------------------------------------

/**
 * Replace a live api_key's NEW-WORLD model whitelist (`model_allowlist`):
 * supply_model external names this key may call; `[]` = allow ALL models
 * (mirrors the `resource_allowlist` semantics). Returns `false` when the key
 * is unknown / soft-deleted.
 */
export async function updateApiKeyModelAllowlist(
  db: DbOrTx,
  keyId: string,
  models: string[],
): Promise<boolean> {
  const rows = await db
    .update(apiKey)
    .set({ modelAllowlist: models, updatedAt: new Date() })
    .where(and(eq(apiKey.id, keyId), isNull(apiKey.deletedAt)))
    .returning({ id: apiKey.id });
  return rows.length === 1;
}

/**
 * Read a live api_key's NEW-WORLD model whitelist (`model_allowlist`) —
 * consumed by the 批次4 gateway face (§2.6 guard 强制 + §5 发现面交集).
 * `[]` = allow ALL models; `undefined` = the key is unknown / soft-deleted.
 */
export async function getApiKeyModelAllowlist(
  db: DbOrTx,
  keyId: string,
): Promise<string[] | undefined> {
  const rows = await db
    .select({ modelAllowlist: apiKey.modelAllowlist })
    .from(apiKey)
    .where(and(eq(apiKey.id, keyId), isNull(apiKey.deletedAt)))
    .limit(1);
  return rows[0]?.modelAllowlist;
}

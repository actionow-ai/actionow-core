import type {
  ArtifactPolicy,
  DialectRef,
  FetchProfile,
  ModelOperation,
  OfferingParamDecl,
  PriceSpec,
  QuotaMirror,
} from '@actionow/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { secretRef } from './catalog.js';
import { faultPolicy } from './fault-policy.js';
import { tenant } from './identity.js';
import { limitPlan } from './limit.js';
import { routeGroup } from './route-group.js';

// model-supply-greenfield 批次1 — the seven NEW-WORLD supply tables (design §2:
// provider / channel / credential / model / offering + price_card + model_grant).
// Everything is `supply_`-prefixed: `model`/`model_grant` would collide with the
// old-world tables, and a uniform prefix keeps the two worlds visually separate
// while they coexist. Old-world tables (resource / upstream_channel /
// channel_model / model / model_grant …) are NOT touched by this file.
//
// Field shapes are derived 1:1 from the FROZEN batch-0 contracts
// (@actionow/contracts supply-entities.ts / supply-params.ts) — snake_case
// column names, text+CHECK enums (no pgEnum anywhere in this repo), jsonb
// $type<> for nested SPEC objects. Partial unique indexes (`WHERE deleted_at
// IS NULL`, the mig 0052 pattern) let soft-deleted rows free their unique slot
// (§2.7 末段).

/**
 * 价格卡 price_card (§2.7 / §9.2) — referenced by {@link supplyModel} as the
 * SALE card and by {@link supplyOffering} as the COST card (two independent,
 * reconcilable sides).
 *
 * IMMUTABILITY CONTRACT: a row is treated as IMMUTABLE once effective — a price
 * change INSERTS a new row (`version + 1`, `createSupplyPriceCardVersion`) and
 * re-points the referencing model/offering; there is deliberately NO update
 * repo for this table. Billing events snapshot `{card_id, version}`
 * (`priceCardSnapshotRefSchema`) so history reconstructs exactly even after
 * re-pointing or soft-deletion.
 */
export const supplyPriceCard = pgTable(
  'supply_price_card',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** One of the seven retained pricing methods (µUSD 七法; must equal `spec.method`). */
    method: text('method').notNull(),
    /** Metering unit label (token / second / image / request …). */
    unit: text('unit').notNull(),
    /** Tier dimensions = the billing_relevant canonical param names keying the tiers (§4). */
    tierDims: jsonb('tier_dims')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The rate spec (same discriminated shapes the pricebook uses; all-integer µ-unit math). */
    spec: jsonb('spec').$type<PriceSpec>().notNull(),
    currency: text('currency').notNull().default('usd'),
    version: integer('version').notNull().default(1),
    /** The instant this version takes effect. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'supply_price_card_method_allowed',
      sql`${t.method} IN ('unit', 'matrix', 'fixed', 'formula', 'passthrough', 'model_token', 'credits')`,
    ),
  ],
);

/**
 * 厂商 provider (§2.2) — a WEAK entity: brand + defaults, not bound to
 * modality. Its dialect/fault/region values are DEFAULTS a channel may
 * override.
 */
export const supplyProvider = pgTable(
  'supply_provider',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    /** Brand display name. */
    name: text('name').notNull(),
    /** Selectable icon key (icon_asset.key); null → brand-registry fallback. */
    icon: text('icon'),
    /** Default dialect (adapter ref + version); a channel may override (官方 vs 中转分叉点, §2.3). */
    defaultDialect: jsonb('default_dialect').$type<DialectRef>().notNull(),
    /** Callback signature-verification template (§2.2); shape is dialect-defined (batch 2) — opaque here. */
    callbackVerification: jsonb('callback_verification').$type<Record<string, unknown>>(),
    /** Default fault-tolerance policy; channels/offerings may override. */
    defaultFaultPolicyId: uuid('default_fault_policy_id').references(() => faultPolicy.id),
    /** Default region / compliance domain. */
    region: text('region'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique: only LIVE rows reserve the slug (mig 0052 pattern).
    uniqueIndex('supply_provider_slug_idx')
      .on(t.slug)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * 渠道 channel (§2.3) — ONE callable upstream access point under a provider.
 * `tenant_id` is the ownership dimension: null = platform-operated; set =
 * tenant-owned BYOK (offerings born from a tenant-private channel are routable
 * by THAT tenant only).
 */
export const supplyChannel = pgTable(
  'supply_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => supplyProvider.id),
    name: text('name').notNull(),
    /** Dialect override; null → inherit provider.default_dialect. */
    dialect: jsonb('dialect').$type<DialectRef>(),
    /** Upstream base URL; null → the dialect's built-in default. */
    baseUrl: text('base_url'),
    /**
     * Egress proxy binding — SAME semantics as `upstream_channel.proxy_ref`: a
     * LOOSE locator (NOT an FK) resolved by `resolveSecretRef` to a managed
     * `proxy.id` (decrypted URL) or a `SECRET_<LOCATOR>` env value; null →
     * direct egress (global UPSTREAM_PROXY_URL / none).
     */
    proxyRef: text('proxy_ref'),
    /** Region / compliance domain; null → provider default. */
    region: text('region'),
    /** Determines the credential secret schema (§2.3 鉴权方案决定凭证 schema). */
    authScheme: text('auth_scheme').notNull(),
    /** BYOK ownership: null = 平台自营, set = 租户自有 (offerings visible to that tenant only). */
    tenantId: uuid('tenant_id').references(() => tenant.id),
    routeGroupId: uuid('route_group_id').references(() => routeGroup.id),
    /** Routing tags (X-Actionow-Route-Tag narrow-only pinning; per D7 identical on the task path). */
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('supply_channel_provider_idx').on(t.providerId),
    index('supply_channel_tenant_idx').on(t.tenantId),
    check(
      'supply_channel_auth_scheme_allowed',
      sql`${t.authScheme} IN ('bearer', 'x_api_key', 'query', 'ak_sk', 'oauth')`,
    ),
    check('supply_channel_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * 凭证 credential (§2.4) — one key in a channel's key pool. The structured
 * secret (shaped by the channel's auth scheme) lives ENCRYPTED in the existing
 * vault (`secret_ref` + `secret_material`, crypto AAD) — this table NEVER
 * stores plaintext; `secret_hint` is the only redacted display trace. 429/401
 * trip `cooldown_until` + in-pool rotation (key 病与渠道病分开表达: a cooling
 * pool never opens the offering breaker).
 */
export const supplyCredential = pgTable(
  'supply_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => supplyChannel.id),
    name: text('name').notNull(),
    /** The vault ref holding the encrypted structured secret (JSON `CredentialSecret`). */
    secretRefId: uuid('secret_ref_id')
      .notNull()
      .references(() => secretRef.id),
    /** Redacted display hint (e.g. `…f3a9`); the secret itself never leaves the vault. */
    secretHint: text('secret_hint'),
    /** Upstream-declared quota mirror (§2.4); null members = the upstream declared no such limit. */
    quota: jsonb('quota')
      .$type<QuotaMirror>()
      .notNull()
      .default(sql`'{"rpm":null,"tpm":null,"max_concurrency":null}'::jsonb`),
    status: text('status').notNull().default('active'),
    /** Cooling until this instant (429/401 backoff); null = not cooling. */
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('supply_credential_channel_idx').on(t.channelId),
    check('supply_credential_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * 模型 model (§2.1) — the NEW-WORLD product face (卖什么), one row per logical
 * model GLOBALLY. Meets the supply face ONLY at {@link supplyOffering} (hard
 * principle #1). The external unique `name` is the routing address.
 */
export const supplyModel = pgTable(
  'supply_model',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** External unique name (对外唯一名) — the routing address. */
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    /** Selectable icon key (icon_asset.key); null → fallback. */
    icon: text('icon'),
    /** Product-face lifecycle (§10 下线语义: deprecated → header 预告, disabled → 404). */
    status: text('status').notNull().default('draft'),
    /** Modality label (text/image/video/audio/music …) — display/faceting; operations carry the executable semantics. */
    modality: text('modality').notNull(),
    /** Operation surfaces (§2.1): external paradigms + slow marker + canonical param contract per operation. */
    operations: jsonb('operations').$type<ModelOperation[]>().notNull(),
    /** Fine-grained capability features (vision/tool-call/json-schema …). */
    capabilities: jsonb('capabilities')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** SALE price card (§9.2); null = needs_pricing — un-servable, never 0-priced (§10). */
    priceCardId: uuid('price_card_id').references(() => supplyPriceCard.id),
    /**
     * 倍率组 (modifier group) applied on the sale side of the billing stack
     * (§9.2). Deliberately NO FK: the modifier-group wiring lands in 批次4 —
     * until then this is an opaque uuid column.
     */
    modifierGroupId: uuid('modifier_group_id'),
    /** Task default: max run time in seconds; hold TTL = this + buffer (§7.3). */
    maxRunTimeSeconds: integer('max_run_time_seconds'),
    /** Task default: artifact mode + retention (§9.4 产物双轨). */
    artifact: jsonb('artifact')
      .$type<ArtifactPolicy>()
      .notNull()
      .default(sql`'{"mode":"signed","retention_days":null}'::jsonb`),
    /** Fallback chain: supply_model ids to degrade to, in order (§2.1). */
    fallbackModelIds: jsonb('fallback_model_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** External rate-limit plan binding (对外限额); null = none. */
    limitPlanId: uuid('limit_plan_id').references(() => limitPlan.id),
    /** `granted` requires a supply_model_grant(model, tenant) row — a SQL-level gate. */
    visibility: text('visibility').notNull().default('public'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique: only LIVE rows reserve the external name (§2.7 末段).
    uniqueIndex('supply_model_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check(
      'supply_model_status_allowed',
      sql`${t.status} IN ('draft', 'active', 'deprecated', 'disabled')`,
    ),
    check('supply_model_visibility_allowed', sql`${t.visibility} IN ('public', 'granted')`),
  ],
);

/**
 * 供给项 offering (§2.5) — the FIRST-CLASS (model × channel) hard binding
 * (从哪买). Routing consumes ONLY `status: 'enabled'` offerings (hard principle
 * #4 — no soft links, no model_map; the upstream name mapping IS
 * `upstream_model_name`). UNIQUE(model, channel) is a PARTIAL unique so a
 * soft-deleted offering frees the pair (§2.7 末段).
 */
export const supplyOffering = pgTable(
  'supply_offering',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => supplyModel.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => supplyChannel.id),
    /** Lifecycle: draft → probing (golden probe) → enabled (the ONLY routable state) → disabled. */
    status: text('status').notNull().default('draft'),
    /** What the upstream calls this model (the ONLY upstream-name mapping in the new world). */
    upstreamModelName: text('upstream_model_name').notNull(),
    /** HOW the upstream delivers (§3: direct / stream / submit_poll / submit_callback). */
    fetchProfile: jsonb('fetch_profile').$type<FetchProfile>().notNull(),
    /** Per-offering timeout budget (seconds); effective = min(model.max_run_time_seconds, this). */
    timeoutBudgetSeconds: integer('timeout_budget_seconds'),
    /** §4 declarations; ABSENT param rows mean supports-full-domain (缺省 = supports 全域). */
    paramDeclarations: jsonb('param_declarations')
      .$type<OfferingParamDecl[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** COST price card (§2.7); null = cost not yet declared (reconciliation degraded). */
    costPriceCardId: uuid('cost_price_card_id').references(() => supplyPriceCard.id),
    /** Offering-side concurrency cap; effective = min(this, credential quota mirror) (§7.8). */
    maxConcurrency: integer('max_concurrency'),
    /** Same-tier random-weighted routing weight (§8). */
    weight: integer('weight').notNull().default(1),
    /** Routing tier — sorted descending before weight randomization (§8). */
    tier: integer('tier').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique (§2.5 UNIQUE(model, channel)): soft-deleted rows free the pair.
    uniqueIndex('supply_offering_model_channel_idx')
      .on(t.modelId, t.channelId)
      .where(sql`deleted_at IS NULL`),
    index('supply_offering_model_idx').on(t.modelId),
    index('supply_offering_channel_idx').on(t.channelId),
    check(
      'supply_offering_status_allowed',
      sql`${t.status} IN ('draft', 'probing', 'enabled', 'disabled')`,
    ),
  ],
);

/**
 * Grants a `granted`-visibility {@link supplyModel} to one tenant (§2.1 —
 * mirrors the old-world `model_grant` shape exactly). `public` models need no
 * grant. HARD-deleted (no soft-delete); unique on `(model_id, tenant_id)` so a
 * duplicate grant is a no-op-safe upsert target.
 */
export const supplyModelGrant = pgTable(
  'supply_model_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => supplyModel.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('supply_model_grant_model_tenant_idx').on(t.modelId, t.tenantId)],
);

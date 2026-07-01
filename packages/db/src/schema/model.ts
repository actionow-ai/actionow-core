import type { ModelParamProfile, ParamOverride } from '@actionow/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { resource, upstreamChannel } from './catalog.js';
import { tenant } from './identity.js';

/**
 * The relay model catalog (§支柱C C.1). Each row maps a public model `name`
 * (the string a caller sends in the OpenAI/Anthropic/Gemini request body) to
 * one chat `resource` (which carries the upstream channels / routing /
 * credentials). `visibility` is `public` (every tenant) or `tenant` (only
 * tenants with a `model_grant` row). `input_price`/`output_price` are
 * **µUSD per 1M tokens** integers (the operator's resale price; `$X/1M → X×1e6`).
 * `capabilities`
 * is a jsonb feature flag map (tools/vision/audio/json/stream) read by Track A.
 */
export const model = pgTable(
  'model',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    display: text('display'),
    modality: text('modality').notNull().default('chat'),
    capabilities: jsonb('capabilities')
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    visibility: text('visibility').notNull().default('public'), // public | tenant
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    inputPrice: bigint('input_price', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    outputPrice: bigint('output_price', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * Optional µUSD per 1M CACHED-input tokens (用拆分计费). Frozen into the
     * `model_token` pricebook spec so `priceModelToken` bills prompt-cached input
     * (`usage.cached_input_tokens`, captured by #70) at this cheaper rate instead
     * of the full `input_price`. Auto-wired from a matched
     * `official_model_price.cached_input_price_per_1m` (sync-models / admin create
     * / update). Nullable → non-breaking: when null, ALL input bills at
     * `input_price` exactly as before.
     */
    cachedInputPrice: bigint('cached_input_price', { mode: 'bigint' }),
    /**
     * Frozen runtime snapshot of the model's parameter profile
     * (`ModelParamProfile` = { features, parameterRules, dropPolicy }), populated
     * by `sync-models` / admin create+update FROM the matched `model_spec` (D1) —
     * mirrors how `input_price` is frozen from `official_model_price`. Null →
     * empty profile == today's passthrough behavior. Loaded on the SAME row already
     * fetched in `resolveModelForTenant`, so ZERO extra query on the hot path.
     */
    paramProfile: jsonb('param_profile').$type<ModelParamProfile>(),
    // Set `true` by `sync-models` when no official price matched the discovered
    // slug (Track 2; spec D7). Such a model is created `disabled` and is NEVER
    // billable at 0 — it stays out of routing until an admin prices it.
    needsPricing: boolean('needs_pricing').notNull().default(false),
    /**
     * Per-model rate limit in requests/minute (模型限流): a per-(tenant, model)
     * cap enforced by the relay's RateLimitGuard ON TOP of the tenant/resource
     * caps. Null → no model-specific cap (the resource/tenant defaults apply).
     */
    rateLimit: integer('rate_limit'),
    /**
     * Ordered model-degradation chain (模型降级链): when a BLOCKING chat for this
     * model fails retryably (all its channels exhausted), the relay retries with
     * each model name here in order. Null/[] → no fallback. Each must be another
     * routable model the tenant can use.
     */
    fallbackModels: jsonb('fallback_models').$type<string[]>(),
    /**
     * Catalog metadata (ZenMux-style facets; catalog-tags-ia). All additive,
     * nullable/defaulted — they enrich browsing/filtering, never gate routing.
     */
    // Free-form operator tags for faceting (推荐/便宜/长上下文/代码…).
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // The model's developer/maker (anthropic/alibaba/z-ai…) — the 开发者 axis; distinct from provider_type (= protocol/adapter).
    maker: text('maker'),
    // Max context window in tokens (上下文 facet); null when unknown.
    contextLength: integer('context_length'),
    // Reasoning mode: none | optional | always (无/可切换/始终); null when unset.
    reasoning: text('reasoning'),
    // Selectable icon key (icon_asset.key); null → inherit channel/plugin icon / monogram.
    icon: text('icon'),
    // status allowed values: active | disabled (create default + admin DTO + sync insert)
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique index: only LIVE rows reserve their `name`. A soft-deleted
    // model (deleted_at set) frees its name so a fresh `createModel` inserts a
    // NEW live row, leaving the old soft-deleted row intact for audit.
    uniqueIndex('model_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    index('model_resource_idx').on(t.resourceId),
    check('model_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
    // Security-relevant: visibility gates model_grant access ('tenant' = grant-only).
    check('model_visibility_allowed', sql`${t.visibility} IN ('public', 'tenant')`),
  ],
);

/**
 * Grants a `tenant`-visibility {@link model} to one tenant. `public` models
 * need no grant. Unique on `(model_id, tenant_id)` so a duplicate grant is a
 * no-op-safe upsert target.
 */
export const modelGrant = pgTable(
  'model_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => model.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('model_grant_model_tenant_idx').on(t.modelId, t.tenantId)],
);

/**
 * Channel↔model membership (catalog supply-hierarchy): which `upstream_channel`
 * serves which {@link model}. Seeded by `syncChannelModels`, operator-editable;
 * models stay platform-scoped (`model.resource_id`). Presence = "this channel can
 * serve this model" — routing prefers a model's linked channels and falls back to
 * the platform's others (see `ChannelRoutingService`). Defined here (not in
 * catalog.ts) to avoid a schema import cycle: model.ts already imports catalog.ts.
 */
export const channelModel = pgTable(
  'channel_model',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => upstreamChannel.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => model.id),
    /**
     * Per-(model,channel) parameter override (`ParamOverride` = { ops: ParamOp[] }):
     * ops of set/clamp/delete applied to the IR before the adapter renders the wire
     * body (engine pipeline step ②, precedence request > ② this > dialect default).
     * Null → no override == today's behavior (the regression invariant). This is
     * the home of "same model, different params per channel (direct vs relay)".
     */
    paramOverride: jsonb('param_override').$type<ParamOverride>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.modelId] }),
    index('channel_model_model_idx').on(t.modelId),
    index('channel_model_channel_idx').on(t.channelId),
  ],
);

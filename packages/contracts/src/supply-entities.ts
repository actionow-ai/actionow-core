// packages/contracts/src/supply-entities.ts
//
// model-supply-greenfield 批次0 — the FROZEN supply-entity contracts (design
// §2): the five-entity supply skeleton provider / channel / credential /
// model / offering PLUS the sixth table price_card (§2.7 — explicitly listed
// so batch 1 cannot forget to model it; referenced by model as the SALE card
// and by offering as the COST card).
//
// These are the canonical entity shapes batch 1 derives its db schema from
// and the admin CRUD serves. Entity fields are snake_case (the
// catalog-views/db convention); nested SPEC objects (fetch profile, dialect
// ref, param declarations) are camelCase inside per the pricing/param-profile
// jsonb precedent — except where the design names a snake_case field.
//
// Constraints zod cannot carry (batch 1 duties, pinned here so they are not
// lost): offering UNIQUE(model, channel) and the model external unique name
// use PARTIAL unique indexes (`WHERE deleted_at IS NULL`, the mig 0052
// pattern) so soft-deleted rows free their slot; billing events and audit keep
// FK integrity to soft-deleted entities (append-only, no cascade).
//
// FREEZE CONTRACT (批次0 只增不改): additive-only after landing.
import { z } from 'zod';

import { ARTIFACT_MODES, OPERATIONS, PARADIGMS } from './gateway-ir.js';
import { PRICE_METHODS, priceSpecSchema } from './pricing.js';
import { canonicalParamSchema, offeringParamDeclSchema } from './supply-params.js';

// --- shared vocabulary --------------------------------------------------------

/**
 * Channel auth schemes (§2.3) — the scheme DETERMINES the credential's
 * structured-secret shape (see {@link credentialSecretSchema}).
 */
export const AUTH_SCHEMES = ['bearer', 'x_api_key', 'query', 'ak_sk', 'oauth'] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/** Model product-face lifecycle (§2.1; §10 下线语义: deprecated → header 预告, then disabled → 404 model_not_found). */
export const MODEL_STATUSES = ['draft', 'active', 'deprecated', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Model visibility (§2.1): `granted` requires a model_grant(model, tenant) row — a SQL-level gate. */
export const MODEL_VISIBILITIES = ['public', 'granted'] as const;
export type ModelVisibility = (typeof MODEL_VISIBILITIES)[number];

/**
 * Offering lifecycle (§2.5): draft → probing (golden probe running) → enabled
 * (routable — the ONLY state routing consumes) → disabled (no NEW requests;
 * in-flight tasks run to completion).
 */
export const OFFERING_STATUSES = ['draft', 'probing', 'enabled', 'disabled'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const CHANNEL_STATUSES = ['active', 'disabled'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Credential admin status; 429/401 COOLDOWN is the separate runtime `cooldown_until` (§2.4 — key 病与渠道病分开表达). */
export const CREDENTIAL_STATUSES = ['active', 'disabled'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * fetch_profile modes (§3) — HOW the upstream delivers, an offering-private
 * concern the execution planner consumes. `direct` = one blocking HTTP call
 * (AT-MOST-ONCE: no upstream handle, crash takeover ⇒ failed + NO charge,
 * never re-submit; runs on the dedicated long-blocking pool); `stream` =
 * SSE/chunked (pre-commit stays); `submit_poll` / `submit_callback` are the
 * RECOVERABLE modes (lease takeover §7.2) and get a routing preference weight
 * (§3).
 */
export const FETCH_MODES = ['direct', 'stream', 'submit_poll', 'submit_callback'] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

/**
 * A versioned dialect (adapter) reference (§6 热更新一致性: the registry is
 * addressed by ref+version so multi-replica stays consistent and canary
 * rollout switches version per-offering).
 */
export const dialectRefSchema = z.object({
  ref: z.string().min(1),
  version: z.string().min(1),
});
export type DialectRef = z.infer<typeof dialectRefSchema>;

// --- provider (§2.2) ------------------------------------------------------------

/**
 * 厂商 provider — a WEAK entity: brand + defaults, NOT bound to modality. Its
 * dialect/fault/region values are DEFAULTS channels may override.
 */
export const providerSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  /** Brand display name. */
  name: z.string().min(1),
  /** Selectable icon key (icon_asset.key); null → brand-registry fallback. */
  icon: z.string().nullable(),
  /** Default dialect (adapter ref + version); a channel may override (官方 vs 中转分叉点, §2.3). */
  default_dialect: dialectRefSchema,
  /**
   * Callback signature-verification template for this provider's task
   * callbacks (§2.2; consumed by adapter aspect ⑥ verifyCallback). Shape is
   * dialect-defined (batch 2) — opaque config here.
   */
  callback_verification: z.record(z.string(), z.unknown()).nullable(),
  /** Default fault-tolerance policy (fault_policy id); channels/offerings may override. */
  default_fault_policy_id: z.string().nullable(),
  /** Default region / compliance domain. */
  region: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Provider = z.infer<typeof providerSchema>;

// --- channel (§2.3) ----------------------------------------------------------------

/**
 * 渠道 channel — ONE callable upstream access point under a provider.
 * `tenant_id` is the ownership dimension: null = platform-operated; set =
 * tenant-owned BYOK (the tenant brought its own credentials — offerings born
 * from a tenant-private channel are routable by THAT tenant only).
 */
export const channelSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  name: z.string().min(1),
  /** Dialect override; null → inherit provider.default_dialect. */
  dialect: dialectRefSchema.nullable(),
  /** Upstream base URL; null → the dialect's built-in default. */
  base_url: z.string().nullable(),
  /** Egress proxy ref (encrypted proxy table); null → direct egress. */
  proxy_ref: z.string().nullable(),
  /** Region / compliance domain; null → provider default. */
  region: z.string().nullable(),
  /** Determines the credential secret schema (§2.3). */
  auth_scheme: z.enum(AUTH_SCHEMES),
  /** BYOK ownership: null = 平台自营, set = 租户自有 (offerings visible to that tenant only). */
  tenant_id: z.string().nullable(),
  route_group_id: z.string().nullable(),
  /** Routing tags (X-Actionow-Route-Tag narrow-only pinning; per D7 identical on the task path). */
  tags: z.array(z.string()).default([]),
  status: z.enum(CHANNEL_STATUSES),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

// --- credential (§2.4) ----------------------------------------------------------------

/**
 * The structured secret material, shaped by the channel's auth scheme (§2.3
 * 鉴权方案决定凭证 schema). WRITE-SIDE ONLY: stored encrypted (crypto AAD
 * vault); entity views NEVER serve it (see {@link credentialSchema}).
 */
export const credentialSecretSchema = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('bearer'), api_key: z.string().min(1) }),
  z.object({ scheme: z.literal('x_api_key'), api_key: z.string().min(1) }),
  z.object({ scheme: z.literal('query'), api_key: z.string().min(1) }),
  z.object({
    scheme: z.literal('ak_sk'),
    access_key: z.string().min(1),
    secret_key: z.string().min(1),
    /** Some AK/SK signers require a signing region (e.g. volc). */
    region: z.string().optional(),
  }),
  z.object({
    scheme: z.literal('oauth'),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    refresh_token: z.string().optional(),
    access_token: z.string().optional(),
  }),
]);
export type CredentialSecret = z.infer<typeof credentialSecretSchema>;

/**
 * Upstream-declared quota mirror (§2.4 上游申明配额镜像) — what the PROVIDER
 * granted this key, mirrored for the governance layer-3 gate (§9.1) and the
 * concurrency clamp `min(offering.max_concurrency, credential quota)` (§7.8).
 * null = the upstream declared no such limit.
 */
export const quotaMirrorSchema = z.object({
  rpm: z.number().int().positive().nullable(),
  tpm: z.number().int().positive().nullable(),
  max_concurrency: z.number().int().positive().nullable(),
});
export type QuotaMirror = z.infer<typeof quotaMirrorSchema>;

/**
 * 凭证 credential — one key in a channel's key pool (§2.4: a channel hangs N
 * of them). 429/401 trip `cooldown_until` + in-pool rotation; a 429 counts
 * toward CREDENTIAL cooldown and NEVER toward offering breaker samples (the
 * breaker eats 5xx/timeouts/protocol errors only); an all-cooled pool marks
 * the offering 暂不可用 (filtered) WITHOUT opening the breaker.
 */
export const credentialSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  name: z.string().min(1),
  /** Redacted display hint (e.g. `sk-…f3a9`); the secret itself never leaves the vault. */
  secret_hint: z.string().nullable(),
  quota: quotaMirrorSchema,
  status: z.enum(CREDENTIAL_STATUSES),
  /** Cooling until this instant (429/401 backoff); null = not cooling. */
  cooldown_until: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Credential = z.infer<typeof credentialSchema>;

// --- model (§2.1) ----------------------------------------------------------------

/**
 * One operation surface a model exposes (§2.1 语义): the EXTERNAL paradigm set
 * callers see (对外范式挂模型 — hard principle #2) + the `slow` auto-upgrade
 * marker (§3: slow ⇒ sync endpoints answer 202+Task, pure server-side, no
 * client opt-in) + the canonical param contract FOR this operation (§4 —
 * canonical 契约唯一挂模型).
 */
export const modelOperationSchema = z.object({
  operation: z.enum(OPERATIONS),
  paradigms: z.array(z.enum(PARADIGMS)).min(1),
  slow: z.boolean().default(false),
  params: z.array(canonicalParamSchema).default([]),
});
export type ModelOperation = z.infer<typeof modelOperationSchema>;

/**
 * Artifact defaults (§9.4 产物双轨 product ruling): `signed` = signed URL +
 * retention (expired after); `public` = stable public URL (gallery mode).
 * Request-level override allowed within tenant policy.
 */
export const artifactPolicySchema = z.object({
  mode: z.enum(ARTIFACT_MODES).default('signed'),
  /** Retention days for signed-track artifacts; null = platform default. */
  retention_days: z.number().int().positive().nullable().default(null),
});
export type ArtifactPolicy = z.infer<typeof artifactPolicySchema>;

/**
 * 模型 model — the PRODUCT face (卖什么), one row per logical model GLOBALLY
 * (§2.1). Meets the supply face ONLY at offerings (hard principle #1). The
 * external unique `name` is what callers address; uniqueness via partial
 * unique index (batch 1).
 */
export const modelSchema = z.object({
  id: z.string(),
  /** External unique name (对外唯一名) — the routing address. */
  name: z.string().min(1),
  display_name: z.string().min(1),
  icon: z.string().nullable(),
  status: z.enum(MODEL_STATUSES),
  /** Modality label (text/image/video/audio/music …) — display/faceting; operations carry the executable semantics. */
  modality: z.string().min(1),
  operations: z.array(modelOperationSchema).min(1),
  /** Fine-grained capability features (vision/tool-call/json-schema …, the MODEL_FEATURES vocabulary). */
  capabilities: z.array(z.string()).default([]),
  /** SALE price card (§2.7/§9.2); null = needs_pricing — the gate keeps the model un-servable, never 0-priced (§10). */
  price_card_id: z.string().nullable(),
  /** 倍率组 (modifier group) applied on the sale side of the billing stack (§9.2). */
  modifier_group_id: z.string().nullable(),
  /** Task default: max run time in seconds; hold TTL = this + buffer (§7.3 — decoupled from the old 15min default). */
  max_run_time_seconds: z.number().int().positive().nullable(),
  /** Task default: artifact mode + retention (§9.4). */
  artifact: artifactPolicySchema,
  /** Fallback chain: model ids to degrade to, in order (§2.1; every hop re-runs param filtering §4 rule 5). */
  fallback_model_ids: z.array(z.string()).default([]),
  /** External rate-limit plan binding (对外限额); null = none. */
  limit_plan_id: z.string().nullable(),
  visibility: z.enum(MODEL_VISIBILITIES).default('public'),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Model = z.infer<typeof modelSchema>;

// --- offering (§2.5) ----------------------------------------------------------------

/**
 * How this offering fetches from its upstream (§3). An object (not a bare
 * enum) so mode-specific tuning knobs land ADDITIVELY in later batches
 * without reshaping the frozen field.
 */
export const fetchProfileSchema = z.object({
  mode: z.enum(FETCH_MODES),
});
export type FetchProfile = z.infer<typeof fetchProfileSchema>;

/**
 * 供给项 offering — the FIRST-CLASS (model × channel) hard binding
 * (UNIQUE(model, channel); 从哪买). Routing consumes ONLY `status: 'enabled'`
 * offerings (hard principle #4 — no soft channel_model links, no model_map
 * resurrection; the upstream name mapping IS `upstream_model_name`). Health &
 * breaker state key off the offering (per (channel, model)) at runtime —
 * default breaker params carry over (60s window / 50% / 20 samples); those are
 * runtime tables, not frozen entity fields.
 */
export const offeringSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  channel_id: z.string(),
  status: z.enum(OFFERING_STATUSES),
  /** What the upstream calls this model (the ONLY upstream-name mapping in the new world). */
  upstream_model_name: z.string().min(1),
  fetch_profile: fetchProfileSchema,
  /** Per-offering timeout budget (seconds); effective budget = min(model.max_run_time_seconds, this) (§2.5). null = model's alone. */
  timeout_budget_seconds: z.number().int().positive().nullable(),
  /** §4 declarations; ABSENT param rows mean supports-full-domain (缺省 = supports 全域). */
  param_declarations: z.array(offeringParamDeclSchema).default([]),
  /** COST price card (§2.7); null = cost not yet declared (reconciliation degraded). */
  cost_price_card_id: z.string().nullable(),
  /** Offering-side concurrency cap; effective = min(this, credential quota mirror) held per (offering, credential) (§7.8). null = credential-only. */
  max_concurrency: z.number().int().positive().nullable(),
  /** Same-tier random-weighted routing weight (§8). */
  weight: z.number().int().nonnegative().default(1),
  /** Routing tier — sorted descending before weight randomization (§8). */
  tier: z.number().int().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Offering = z.infer<typeof offeringSchema>;

// --- price_card (§2.7 / §9.2 — the sixth table) -----------------------------------

/**
 * 价格卡 price_card (§9.2): { 计价法(七法沿用) / 单位 / tier 维度 =
 * billing_relevant 参数组合 / 单价 / 币种 / 版本 / 生效时间 }. Referenced by
 * model (sale) AND offering (cost); the two sides are independent and
 * reconcilable (§9.2 叠加顺序: cost card ‖ sale card → modifier group → tenant
 * discount). VERSIONED with history retained — billing events snapshot
 * {@link priceCardSnapshotRefSchema} (card id + version), never a live ref.
 */
export const priceCardSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    /** One of the seven retained pricing methods (µUSD 七法, pricing.ts). */
    method: z.enum(PRICE_METHODS),
    /** Metering unit label (token / second / image / request …). */
    unit: z.string().min(1),
    /** Tier dimensions = the billing_relevant canonical param names keying the tiers (§4). */
    tier_dims: z.array(z.string()).default([]),
    /** The rate spec (same discriminated shapes the pricebook uses; all-integer µ-unit math). */
    spec: priceSpecSchema,
    currency: z.string().min(1).default('usd'),
    version: z.number().int().positive(),
    /** ISO instant this version takes effect. */
    effective_at: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((card, ctx) => {
    if (card.method !== card.spec.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'method must equal spec.method',
        path: ['spec', 'method'],
      });
    }
  });
export type PriceCard = z.infer<typeof priceCardSchema>;

/**
 * The immutable price snapshot a billing event records (§9.2 计费事件打价格
 * 快照 — 卡 id + 版本): reconstructs the exact rates later even after the card
 * gains new versions or its entity is soft-deleted.
 */
export const priceCardSnapshotRefSchema = z.object({
  card_id: z.string(),
  version: z.number().int().positive(),
});
export type PriceCardSnapshotRef = z.infer<typeof priceCardSnapshotRefSchema>;

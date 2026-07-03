import { featuresToCapabilities } from '@actionow/contracts';
import {
  createModel,
  createPricebookEntry,
  createResource,
  createSecretRef,
  createUpstreamChannel,
  type Database,
  freezeParamProfile,
  getModelSpec,
  getResource,
  linkChannelModelsByNames,
  matchOfficialPrice,
} from '@actionow/db';

/**
 * Task 12 — the real-provider catalog seed. This module is the ONE place a
 * vendor's protocol may appear, and it appears ONLY as DATA (catalog rows): no
 * reusable code path (adapter / engine / api) names a vendor.
 *
 * The async media relay is the GENERIC `async-media` adapter; its vendor
 * protocol — base URL, task submit/poll paths, model ids, and webhook
 * signature/timestamp header names — lives entirely in the seeded
 * `upstream_channel` row's `endpoint` / `model` / `config` / `credential_ref`
 * (decision 5). Direct openai/anthropic/gemini channels are seeded `active`
 * with a `proxy_ref` so they are reachable once an egress proxy is configured
 * (decision 4). Pricing is PLACEHOLDER (decision 3): media prices per-task,
 * chat per-token; refine later in the admin pricebook.
 *
 * The seed does NO network: it only writes catalog rows. It is idempotent
 * (find-then-create on the resource id), so re-running it is a no-op.
 *
 * CREDENTIAL RESOLUTION: a channel's `credential_ref` points at a `secret_ref`
 * row whose `locator` is the env-key REF the {@link SecretResolver} maps to
 * `process.env[SECRET_<REF>]` (e.g. locator `huimeng` → `SECRET_HUIMENG`).
 * The proxy locator `upstream_proxy` resolves to `SECRET_UPSTREAM_PROXY`, with
 * the global `UPSTREAM_PROXY_URL` as the engine-level fallback.
 */

/** A frozen `io_schema` snapshot for a text (chat) resource version. */
// Chat/text resources are driven by the OpenAI/Anthropic/Gemini DIALECT relays
// (`/v1/chat/completions` etc.), which build the upstream request from the chat
// IR (messages) — NOT from `io_schema.inputs`. A `prompt`-required io_schema here
// would make the chat relay reject every call ("prompt: Required"), so chat
// resources carry an EMPTY io_schema (matching the seeded chat-codex resource).
const TEXT_IO = {
  inputs: [],
  outputs: [],
};
/** A frozen `io_schema` snapshot for an image resource version. `model` is an
 * optional passthrough input: when present it selects the upstream image model
 * (media model passthrough — one relay serves seedream-4.5 / 5.0-lite / …); it
 * survives the STRICT io_schema validation and the async-media adapter lifts it
 * to the task's top-level `model` (never into `params`). */
const IMAGE_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'size', type: 'string', required: false },
    { key: 'model', type: 'string', required: false },
  ],
  outputs: [{ key: 'image_url', type: 'string' }],
};
/** A frozen `io_schema` snapshot for a video resource version. `model` is the
 * optional per-request upstream video model (seedance-* / kling-* …); see IMAGE_IO. */
const VIDEO_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'duration', type: 'number', required: false },
    { key: 'ratio', type: 'string', required: false },
    { key: 'model', type: 'string', required: false },
  ],
  outputs: [{ key: 'video_url', type: 'string' }],
};
/**
 * A frozen `io_schema` snapshot for the speech-to-text resource. EMPTY (like the
 * chat/embeddings relay resources): the STT relay builds the upstream request
 * from the multipart upload + the IR carried at `inputs.__ir`, NOT from
 * `io_schema.inputs`, so a required input here would make every transcribe call
 * fail strict io_schema validation. The `__ir` key is stripped before validation.
 */
const STT_IO = {
  inputs: [],
  outputs: [],
};

/** Placeholder token pricing: unit/post over the `tokens` dimension (1 µcredit/token). */
const TOKENS_PRICEBOOK = { method: 'unit', dimensions: { tokens: { rate: 1 } } } as const;
/**
 * Image pricing: unit/post per IMAGE (250_000 µcredits each). The `async-media`
 * adapter meters `{ images: N }` from the task result; `tasks` is a same-rate
 * fallback so a result that omits an image count still bills (never settles 0).
 */
const IMAGE_TASK_PRICEBOOK = {
  method: 'unit',
  dimensions: { images: { rate: 250_000 }, tasks: { rate: 250_000 } },
} as const;
/**
 * Video pricing: unit/post per SECOND (300_000 µcredits/s). The adapter meters
 * `{ duration_seconds: S }` from the result's `duration`; `tasks` (1_500_000) is
 * the per-clip fallback when the relay omits a duration (never settles 0).
 */
const VIDEO_TASK_PRICEBOOK = {
  method: 'unit',
  dimensions: { duration_seconds: { rate: 300_000 }, tasks: { rate: 1_500_000 } },
} as const;
/**
 * Speech-to-text pricing: unit/post per SECOND of transcribed audio. The STT
 * relay (`POST /v1/audio/transcriptions`) meters `{ audio_seconds: N }` from the
 * upstream's reported `duration` at settle. Rate = 100 µUSD/s ($0.006/min,
 * mirroring OpenAI Whisper's published price) — sized to OVER the channel's real
 * cost so margin stays positive; refine in the admin pricebook. NO `tasks`
 * fallback dim: the relay always yields `audio_seconds` (falling back to the hold
 * estimate when the upstream omits a duration), so the settle is never 0.
 */
const STT_PRICEBOOK = {
  method: 'unit',
  dimensions: { audio_seconds: { rate: 100 } },
} as const;

/**
 * The async-media relay protocol — the vendor specifics as DATA. The generic
 * `async-media` adapter reads these off `AdapterContext.config` (threaded from
 * `upstream_channel.config`); no path or header name is hardcoded in the
 * adapter. Image and video share one relay, so they share this config.
 */
const RELAY_CONFIG = {
  submitPath: '/api/v1/tasks',
  pollPath: '/api/v1/tasks/{id}',
  signatureHeader: 'X-HuiMeng-Signature',
  timestampHeader: 'X-HuiMeng-Timestamp',
};

/**
 * Video shares the relay protocol but needs a LONGER poll budget — a multi-minute
 * clip would hit `upstream_timeout` at the default ~30s. The job-runner reads
 * `maxPolls`/`pollIntervalMs` off the channel config: 120 × 5s ≈ up to 10 minutes
 * before timing out. (A detached webhook-settled mode is the better long-run fix.)
 */
const RELAY_CONFIG_VIDEO = { ...RELAY_CONFIG, maxPolls: 120, pollIntervalMs: 5000 };

/** One catalog entry to seed: a resource + its pricebook + one upstream channel. */
interface ProviderSeed {
  /** Stable resource id (vendor-neutral; the channel carries the vendor model). */
  readonly id: string;
  readonly kind: string;
  readonly modality: string;
  /** Adapter `provider_type` for both the resource and its channel. */
  readonly providerType: string;
  readonly execModes: readonly string[];
  readonly ioSchema: unknown;
  /** unit/post pricebook spec (µcredits per usage dimension); placeholder rates. */
  readonly pricebookSpec: unknown;
  /** Per-channel upstream base URL; omit to use the adapter default host. */
  readonly endpoint?: string;
  /** Per-channel model id (the vendor model name lives here, as DATA). */
  readonly model: string;
  /**
   * The OFFICIAL catalog vendor key (`openai`|`anthropic`|`google`|`deepseek`…)
   * this `model` belongs to — used to look up its `model_spec` (→ capabilities /
   * param_profile) and `official_model_price`. Distinct from `providerType`: an
   * openai-COMPATIBLE host (DeepSeek) uses the `openai` adapter but is a
   * `deepseek` catalog model. Omit when the model isn't in the catalog (no enrich).
   */
  readonly catalogVendor?: string;
  /** env-key REF for the channel credential (locator → `SECRET_<REF>`). */
  readonly credentialLocator: string;
  /** Relay protocol config DATA (submit/poll paths + signature header names). */
  readonly config?: Record<string, unknown>;
  /** Egress-proxy locator REF; set for direct hosts (decision 4). */
  readonly proxyRef?: string;
  /**
   * For a MEDIA relay (image/video): the upstream model ids to seed as `model`
   * rows + link to the channel, so the relay ships non-empty and each is
   * selectable. `model` (above) is the channel's DEFAULT; a request may pick any
   * of these via media model passthrough (`inputs.model`). Media models bill via
   * the resource pricebook (per-image/second), so they carry no per-token price.
   */
  readonly mediaModels?: readonly string[];
  /** Human-readable name stamped on the seeded `secret_ref` (so the credentials list is legible). */
  readonly credentialName?: string;
}

/** The real-provider catalog entries seeded as DATA (text/image/video/audio + direct hosts). */
const PROVIDER_SEEDS: readonly ProviderSeed[] = [
  // 1. Image relay — generic async-media adapter; HuiMeng (api.huimengi.com)
  // vendor protocol is DATA. `model` is the channel default; `mediaModels` are all
  // the image models HuiMeng offers (verified against its API docs), each seeded +
  // linked so the relay ships non-empty; a request may pick any via passthrough.
  {
    id: 'image-relay',
    kind: 'model',
    modality: 'image',
    providerType: 'async-media',
    execModes: ['async-poll', 'async-callback'],
    ioSchema: IMAGE_IO,
    pricebookSpec: IMAGE_TASK_PRICEBOOK,
    endpoint: 'https://api.huimengi.com',
    model: 'seedream-4.5',
    mediaModels: ['seedream-4.5', 'seedream-5.0-lite'],
    credentialLocator: 'huimeng',
    credentialName: '惠梦中转 HuiMeng',
    config: RELAY_CONFIG,
  },
  // 2. Video relay — same HuiMeng relay, video models (seedance-* + kling-*).
  {
    id: 'video-relay',
    kind: 'model',
    modality: 'video',
    providerType: 'async-media',
    execModes: ['async-poll', 'async-callback'],
    ioSchema: VIDEO_IO,
    pricebookSpec: VIDEO_TASK_PRICEBOOK,
    endpoint: 'https://api.huimengi.com',
    model: 'seedance-2.0',
    mediaModels: [
      'seedance-2.0',
      'seedance-2.0-fast',
      'seedance-2.0-value',
      'seedance-2.0-fast-value',
      'seedance-1.5-pro',
      'seedance-1.0-pro',
      'seedance-1.0-pro-fast',
      'kling-v3',
      'kling-v3-omni',
    ],
    credentialLocator: 'huimeng',
    credentialName: '惠梦中转 HuiMeng',
    config: RELAY_CONFIG_VIDEO,
  },
  // NOTE: no audio relay — HuiMeng offers only image/video (+ text), no audio.
  // 2c. Speech-to-text relay — synchronous OpenAI-dialect STT via the openai
  // adapter's `transcribe` (multipart upload → `/v1/audio/transcriptions`). Routes
  // by RESOURCE (no model row); billed per `audio_seconds` via the unit/post
  // pricebook. Direct OpenAI host → `proxy_ref` so it is reachable via the egress
  // proxy. Point the channel at the operator's real STT host/model in production.
  {
    id: 'stt-relay',
    kind: 'model',
    modality: 'audio',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: STT_IO,
    pricebookSpec: STT_PRICEBOOK,
    model: 'whisper-1',
    credentialLocator: 'openai',
    proxyRef: 'upstream_proxy',
  },
  // 3. DeepSeek chat — openai-compatible host via the openai adapter.
  {
    id: 'deepseek-chat',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    catalogVendor: 'deepseek',
    credentialLocator: 'deepseek',
  },
  // 4. Xiaomi MiMo chat — openai-compatible host (api.xiaomimimo.com/v1, verified).
  // `catalogVendor: 'xiaomi'` binds the web-verified `xiaomi/mimo-v2.5` official
  // price (seed-official-prices.ts) so the model is priced + active, not disabled
  // at 0. MiMo has no `model_spec` yet, so capabilities fall back to the permissive
  // openai-compatible chat default (tools/json/stream) — accurate for MiMo.
  {
    id: 'xiaomi-mimo',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    endpoint: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
    catalogVendor: 'xiaomi',
    credentialLocator: 'xiaomi',
  },
  // 5. relay-text — GPT/Gemini fronted by the openai-compatible relay endpoint.
  {
    id: 'relay-text',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    endpoint: 'https://api.huimengi.com/v1',
    model: 'gpt-5.5',
    catalogVendor: 'openai',
    credentialLocator: 'huimeng',
  },
  // 6a. Direct OpenAI — adapter default host, active + proxy_ref (decision 4).
  {
    id: 'openai-direct',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    model: 'gpt-4o-mini',
    catalogVendor: 'openai',
    credentialLocator: 'openai',
    proxyRef: 'upstream_proxy',
  },
  // 6b. Direct Anthropic.
  {
    id: 'anthropic-direct',
    kind: 'model',
    modality: 'text',
    providerType: 'anthropic',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    model: 'claude-haiku-4-5-20251001',
    catalogVendor: 'anthropic',
    credentialLocator: 'anthropic',
    proxyRef: 'upstream_proxy',
  },
  // 6c. Direct Gemini.
  {
    id: 'gemini-direct',
    kind: 'model',
    modality: 'text',
    providerType: 'gemini',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
    model: 'gemini-2.5-flash',
    catalogVendor: 'google',
    credentialLocator: 'gemini',
    proxyRef: 'upstream_proxy',
  },
];

/** The ids `seedProviders` registers (a stable, ordered list for tests/tooling). */
export const PROVIDER_SEED_IDS: readonly string[] = PROVIDER_SEEDS.map((s) => s.id);

/** Options for {@link seedProviders}. */
export interface SeedProvidersOptions {
  /**
   * LEGACY — retained for call-site compatibility but no longer used to OWN the
   * provider resources. The shared provider relays are created as GLOBAL
   * resources (`tenant_id = null`) so EVERY tenant (= app) on the self-deployed
   * platform may run them; tenant ownership is irrelevant to them.
   */
  readonly tenantId?: string;
}

/**
 * Idempotently register the real-provider catalog (resources + resource
 * versions + pricebooks + upstream channels) as DATA. Network-free; safe to
 * re-run (find-then-create on the resource id makes a second run a no-op).
 */
/** Friendly credential names by locator, so the credentials list is legible. */
const CREDENTIAL_NAMES: Readonly<Record<string, string>> = {
  huimeng: '惠梦中转 HuiMeng',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  xiaomi: '小米 MiMo Xiaomi',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

export async function seedProviders(db: Database, opts: SeedProvidersOptions = {}): Promise<void> {
  void opts; // legacy `tenantId` no longer owns the (global) provider resources.
  // Dedup secret_refs by locator across the run: ONE named credential per vendor
  // key, reused by every channel that shares it — so the credentials list is a
  // short set of named rows, not a pile of blank, indistinguishable ones.
  const secretIdByLocator = new Map<string, string>();
  for (const s of PROVIDER_SEEDS) {
    if ((await getResource(db, s.id)) !== undefined) continue;

    await createResource(db, {
      id: s.id,
      // GLOBAL platform resource: any tenant (= app) on the self-deployed
      // platform may run the shared media/direct-chat relays.
      tenantId: null,
      kind: s.kind,
      modality: s.modality,
      providerType: s.providerType,
      execModes: s.execModes,
      ioSchema: s.ioSchema,
      version: 1,
    });

    await createPricebookEntry(db, {
      resourceId: s.id,
      resourceVersion: 1,
      version: 1,
      method: 'unit',
      timing: 'post',
      spec: s.pricebookSpec,
      active: true,
    });

    // A named `secret_ref` locating the env var that holds the provider key (only
    // the locator is persisted; the resolver materializes the value at run time).
    // Reused across channels that share a locator (dedup).
    let credentialRef = secretIdByLocator.get(s.credentialLocator);
    if (credentialRef === undefined) {
      const name = s.credentialName ?? CREDENTIAL_NAMES[s.credentialLocator] ?? s.credentialLocator;
      const secret = await createSecretRef(db, {
        provider: 'env',
        locator: s.credentialLocator,
        name,
      });
      credentialRef = secret.id;
      secretIdByLocator.set(s.credentialLocator, credentialRef);
    }

    const channel = await createUpstreamChannel(db, {
      resourceId: s.id,
      providerType: s.providerType,
      credentialRef,
      ...(s.endpoint !== undefined ? { endpoint: s.endpoint } : {}),
      model: s.model,
      ...(s.config !== undefined ? { config: s.config } : {}),
      ...(s.proxyRef !== undefined ? { proxyRef: s.proxyRef } : {}),
      weight: 1,
      status: 'active',
    });

    // Chat/text resources need a `model` row so the dialect relays
    // (`/v1/chat/completions` etc.) can resolve the requested model NAME →
    // this resource → its channel. The model name mirrors the channel's vendor id.
    if (s.modality === 'text') {
      // Enrich the model row from the 规格库 spec + official price (SAME source a
      // channel sync uses) so capabilities/param_profile/price/maker/display are
      // real per-model data — not the old fake uniform `{tools,vision,json,stream}`.
      // `catalogVendor` differs from `providerType` for openai-compatible hosts.
      const vendor = s.catalogVendor;
      const spec = vendor !== undefined ? await getModelSpec(db, vendor, s.model) : undefined;
      const official =
        vendor !== undefined ? await matchOfficialPrice(db, vendor, s.model) : undefined;
      const features = spec?.features ?? [];
      // features present → derived gate; else a permissive chat default (avoids a
      // wrongful 400 on a model with no catalog match, e.g. mimo).
      const capabilities =
        features.length > 0
          ? featuresToCapabilities(features)
          : { tools: true, json: true, stream: true };
      const paramProfile = freezeParamProfile(spec);
      const display = spec?.displayName ?? undefined;
      // NEVER sell at a fake near-free price. Only a model with a real matched
      // `official_model_price` is created `active` with that resale price; a model
      // with no verified cost basis is created `disabled` at price 0 — mirroring
      // the channel-sync `needs_pricing` path. A matched official row always
      // carries non-null prices, so its presence IS the "has a verified price" signal.
      const hasOfficialPrice = official !== undefined;
      await createModel(db, {
        name: s.model,
        resourceId: s.id,
        modality: 'chat',
        capabilities,
        ...(paramProfile !== null ? { paramProfile } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(vendor !== undefined ? { maker: vendor } : {}),
        visibility: 'public',
        inputPrice: official?.inputPricePer1m ?? 0n,
        outputPrice: official?.outputPricePer1m ?? 0n,
        ...(official?.cachedInputPricePer1m != null
          ? { cachedInputPrice: official.cachedInputPricePer1m }
          : {}),
        status: hasOfficialPrice ? 'active' : 'disabled',
      });
      // Link the model to its channel so it shows in the channel's model grid.
      await linkChannelModelsByNames(db, channel.id, [s.model]);
    } else if ((s.modality === 'image' || s.modality === 'video') && s.mediaModels !== undefined) {
      // Media models: one `model` row per upstream id the relay serves, all linked
      // to the channel so it ships non-empty + each is selectable. Active with NO
      // per-token price — media bills via the resource pricebook (per-image/second),
      // and a request picks the model via passthrough (`inputs.model`), so a 0 token
      // price is correct (never billed by it). maker/icon inferred from the id.
      for (const name of s.mediaModels) {
        const isKling = name.startsWith('kling');
        await createModel(db, {
          name,
          resourceId: s.id,
          modality: s.modality,
          visibility: 'public',
          inputPrice: 0n,
          outputPrice: 0n,
          maker: isKling ? 'kling' : 'doubao',
          icon: isKling ? 'kling' : 'doubao',
          status: 'active',
        });
      }
      await linkChannelModelsByNames(db, channel.id, [...s.mediaModels]);
    }
  }
}

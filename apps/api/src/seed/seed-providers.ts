import {
  createPricebookEntry,
  createResource,
  createSecretRef,
  createUpstreamChannel,
  type Database,
  getResource,
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
const TEXT_IO = {
  inputs: [{ key: 'prompt', type: 'string', required: true }],
  outputs: [{ key: 'text', type: 'string' }],
};
/** A frozen `io_schema` snapshot for an image resource version. */
const IMAGE_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'size', type: 'string', required: false },
  ],
  outputs: [{ key: 'image_url', type: 'string' }],
};
/** A frozen `io_schema` snapshot for a video resource version. */
const VIDEO_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'duration', type: 'number', required: false },
    { key: 'ratio', type: 'string', required: false },
  ],
  outputs: [{ key: 'video_url', type: 'string' }],
};

/** Placeholder token pricing: unit/post over the `tokens` dimension (1 µcredit/token). */
const TOKENS_PRICEBOOK = { method: 'unit', dimensions: { tokens: { rate: 1 } } } as const;
/** Placeholder image pricing: unit/post over `tasks` (250_000 µcredits/image). */
const IMAGE_TASK_PRICEBOOK = {
  method: 'unit',
  dimensions: { tasks: { rate: 250_000 } },
} as const;
/** Placeholder video pricing: unit/post over `tasks` (1_500_000 µcredits/video). */
const VIDEO_TASK_PRICEBOOK = {
  method: 'unit',
  dimensions: { tasks: { rate: 1_500_000 } },
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
  /** env-key REF for the channel credential (locator → `SECRET_<REF>`). */
  readonly credentialLocator: string;
  /** Relay protocol config DATA (submit/poll paths + signature header names). */
  readonly config?: Record<string, unknown>;
  /** Egress-proxy locator REF; set for direct hosts (decision 4). */
  readonly proxyRef?: string;
}

/** The eight real-provider catalog entries seeded as DATA. */
const PROVIDER_SEEDS: readonly ProviderSeed[] = [
  // 1. Image relay — generic async-media adapter; vendor protocol is DATA.
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
    credentialLocator: 'huimeng',
    config: RELAY_CONFIG,
  },
  // 2. Video relay — same relay, video model.
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
    credentialLocator: 'huimeng',
    config: RELAY_CONFIG,
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
    credentialLocator: 'deepseek',
  },
  // 4. Xiaomi MiMo chat — openai-compatible host.
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
    model: 'claude-3-5-haiku-latest',
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
    model: 'gemini-2.0-flash',
    credentialLocator: 'gemini',
    proxyRef: 'upstream_proxy',
  },
];

/** The ids `seedProviders` registers (a stable, ordered list for tests/tooling). */
export const PROVIDER_SEED_IDS: readonly string[] = PROVIDER_SEEDS.map((s) => s.id);

/** Options for {@link seedProviders}. */
export interface SeedProvidersOptions {
  /** The tenant the resources are registered under. */
  readonly tenantId: string;
}

/**
 * Idempotently register the real-provider catalog (resources + resource
 * versions + pricebooks + upstream channels) as DATA. Network-free; safe to
 * re-run (find-then-create on the resource id makes a second run a no-op).
 */
export async function seedProviders(db: Database, opts: SeedProvidersOptions): Promise<void> {
  for (const s of PROVIDER_SEEDS) {
    if ((await getResource(db, s.id)) !== undefined) continue;

    await createResource(db, {
      id: s.id,
      tenantId: opts.tenantId,
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

    // A `secret_ref` row locating the env var that holds the provider key; only
    // the locator is persisted (the resolver materializes the value at run time).
    const secret = await createSecretRef(db, { provider: 'env', locator: s.credentialLocator });

    await createUpstreamChannel(db, {
      resourceId: s.id,
      providerType: s.providerType,
      credentialRef: secret.id,
      ...(s.endpoint !== undefined ? { endpoint: s.endpoint } : {}),
      model: s.model,
      ...(s.config !== undefined ? { config: s.config } : {}),
      ...(s.proxyRef !== undefined ? { proxyRef: s.proxyRef } : {}),
      weight: 1,
      status: 'active',
    });
  }
}

import { createOfficialPrice, type Database, getOfficialPrice } from '@actionow/db';

/**
 * Track 2 — the official model price catalog seed: the operator's COST BASIS
 * (µUSD per 1M tokens), matched by `sync-models` to auto-price discovered models.
 *
 * Every price below was RE-VERIFIED against the provider's OFFICIAL pricing page
 * on 2026-07-03 (a multi-agent web-research + adversarial-verification pass; each
 * row confirmed input/output/cached against the cited `SOURCES` URL). They remain
 * a STARTING POINT — prices drift — so the operator owns the catalog and updates
 * it via `POST/PATCH /admin/official-prices`. Stored in µUSD/1M = USD × 1e6.
 * Slugs are canonical (lowercase, dateless); the matcher normalizes a discovered
 * slug to the same form. Network-free + idempotent (find-then-create on
 * `(provider, slug)`), so re-running never clobbers an admin's edits.
 *
 * NOTE most OpenAI/Anthropic/Google rows here DUPLICATE a firstparty row the
 * catalog import (`seed-catalog.ts`) already inserts; kept as a fallback for a
 * slim image that ships without `docs/…catalog.json`. The rows that are ONLY here
 * (no catalog entry) are the legacy `gpt-4o`/`gpt-4.1` family, `claude-haiku-4-5`,
 * and `xiaomi/mimo-v2.5` — all web-verified below.
 */

const SOURCES = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  // Xiaomi MiMo open platform — overseas (USD) pricing column.
  xiaomi: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
} as const;

/** Human-readable provenance stamped on every row's `notes`. */
const AS_OF = 'official prices web-verified 2026-07-03';
/** Machine `effective_at` for every seeded row (the verification date). */
const EFFECTIVE_AT = new Date('2026-07-03T00:00:00Z');

/** One seeded catalog row (µUSD per 1M tokens). */
interface CatalogPrice {
  readonly provider: keyof typeof SOURCES;
  readonly modelSlug: string;
  readonly displayName: string;
  readonly inputPricePer1m: bigint;
  readonly outputPricePer1m: bigint;
  readonly cachedInputPricePer1m?: bigint;
}

/** Cited official prices (USD/1M × 1e6 = µUSD/1M). */
const CATALOG: readonly CatalogPrice[] = [
  // OpenAI — developers.openai.com/api/docs/pricing
  {
    provider: 'openai',
    modelSlug: 'gpt-5.5',
    displayName: 'GPT-5.5',
    inputPricePer1m: 5_000_000n,
    outputPricePer1m: 30_000_000n,
    cachedInputPricePer1m: 500_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    inputPricePer1m: 30_000_000n,
    outputPricePer1m: 180_000_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.4',
    displayName: 'GPT-5.4',
    inputPricePer1m: 2_500_000n,
    outputPricePer1m: 15_000_000n,
    cachedInputPricePer1m: 250_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    inputPricePer1m: 750_000n,
    outputPricePer1m: 4_500_000n,
    cachedInputPricePer1m: 75_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 nano',
    inputPricePer1m: 200_000n,
    outputPricePer1m: 1_250_000n,
    cachedInputPricePer1m: 20_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    inputPricePer1m: 30_000_000n,
    outputPricePer1m: 180_000_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    inputPricePer1m: 1_750_000n,
    outputPricePer1m: 14_000_000n,
    cachedInputPricePer1m: 175_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-4o',
    displayName: 'GPT-4o',
    inputPricePer1m: 2_500_000n,
    outputPricePer1m: 10_000_000n,
    cachedInputPricePer1m: 1_250_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    inputPricePer1m: 150_000n,
    outputPricePer1m: 600_000n,
    cachedInputPricePer1m: 75_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-4.1',
    displayName: 'GPT-4.1',
    inputPricePer1m: 2_000_000n,
    outputPricePer1m: 8_000_000n,
    cachedInputPricePer1m: 500_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    inputPricePer1m: 400_000n,
    outputPricePer1m: 1_600_000n,
    cachedInputPricePer1m: 100_000n,
  },
  // Anthropic — platform.claude.com/docs (cached = cache-read, 0.1x base)
  {
    provider: 'anthropic',
    modelSlug: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    inputPricePer1m: 5_000_000n,
    outputPricePer1m: 25_000_000n,
    cachedInputPricePer1m: 500_000n,
  },
  {
    provider: 'anthropic',
    modelSlug: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    inputPricePer1m: 3_000_000n,
    outputPricePer1m: 15_000_000n,
    cachedInputPricePer1m: 300_000n,
  },
  {
    provider: 'anthropic',
    modelSlug: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    inputPricePer1m: 1_000_000n,
    outputPricePer1m: 5_000_000n,
    cachedInputPricePer1m: 100_000n,
  },
  {
    provider: 'anthropic',
    modelSlug: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    inputPricePer1m: 10_000_000n,
    outputPricePer1m: 50_000_000n,
    cachedInputPricePer1m: 1_000_000n,
  },
  // Google Gemini — ai.google.dev/gemini-api/docs/pricing (Pro = <=200K-prompt tier)
  {
    provider: 'google',
    modelSlug: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    inputPricePer1m: 1_250_000n,
    outputPricePer1m: 10_000_000n,
    cachedInputPricePer1m: 125_000n,
  },
  {
    provider: 'google',
    modelSlug: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputPricePer1m: 300_000n,
    outputPricePer1m: 2_500_000n,
    cachedInputPricePer1m: 30_000n,
  },
  {
    provider: 'google',
    modelSlug: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    inputPricePer1m: 100_000n,
    outputPricePer1m: 400_000n,
    cachedInputPricePer1m: 10_000n,
  },
  {
    provider: 'google',
    modelSlug: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    inputPricePer1m: 1_500_000n,
    outputPricePer1m: 9_000_000n,
    cachedInputPricePer1m: 150_000n,
  },
  // Xiaomi MiMo — mimo.mi.com overseas (USD) column, web-verified 2026-07-03.
  // ($0.14 in / $0.28 out / $0.0028 cached). Prices the seeded `xiaomi-mimo`
  // channel (previously created disabled at 0 because MiMo has no catalog entry).
  {
    provider: 'xiaomi',
    modelSlug: 'mimo-v2.5',
    displayName: 'MiMo V2.5',
    inputPricePer1m: 140_000n,
    outputPricePer1m: 280_000n,
    cachedInputPricePer1m: 2_800n,
  },
];

/** The `(provider, slug)` pairs this seed inserts (a stable list for tooling/tests). */
export const OFFICIAL_PRICE_SEED_KEYS: readonly string[] = CATALOG.map(
  (p) => `${p.provider}/${p.modelSlug}`,
);

/**
 * Idempotently insert the official-price catalog rows. Find-then-create on the
 * live `(provider, slug)` pair, so a second run is a no-op (and an admin's edits
 * to an already-seeded row are never clobbered). Network-free.
 */
export async function seedOfficialPrices(db: Database): Promise<void> {
  for (const p of CATALOG) {
    if ((await getOfficialPrice(db, p.provider, p.modelSlug)) !== undefined) continue;
    await createOfficialPrice(db, {
      provider: p.provider,
      modelSlug: p.modelSlug,
      displayName: p.displayName,
      inputPricePer1m: p.inputPricePer1m,
      outputPricePer1m: p.outputPricePer1m,
      ...(p.cachedInputPricePer1m !== undefined
        ? { cachedInputPricePer1m: p.cachedInputPricePer1m }
        : {}),
      // Explicit provenance: these rows are web-verified firstparty prices and ARE
      // a billable cost basis (defaults would give the same, but state it so the
      // row is self-documenting and never mistaken for an unreviewed guess).
      confidence: 'firstparty',
      billingEligible: true,
      effectiveAt: EFFECTIVE_AT,
      sourceUrl: SOURCES[p.provider],
      notes: AS_OF,
    });
  }
}

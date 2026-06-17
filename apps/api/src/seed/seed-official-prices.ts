import { createOfficialPrice, type Database, getOfficialPrice } from '@actionow/db';

/**
 * Track 2 — a SMALL illustrative DRAFT of the official model price catalog. These
 * rows are the operator's COST BASIS (µUSD per 1M tokens), matched by the
 * `sync-models` flow to auto-price discovered models. Every row is marked
 * `notes: 'draft — verify against official page'`: these are realistic PLACEHOLDER
 * numbers, NOT the cited authoritative prices. The real, source-cited catalog is
 * imported separately (admin reviews + records with `source_url`/`effective_at`).
 *
 * Slugs are stored in the catalog's CANONICAL form (lowercase, dateless); the
 * matcher normalizes a discovered slug to the same form before lookup. Network-free
 * + idempotent (find-then-create on `(provider, slug)`), so re-running is a no-op.
 */

const DRAFT_NOTE = 'draft — verify against official page';

/** One seeded draft catalog row (µUSD per 1M tokens). */
interface DraftPrice {
  readonly provider: string;
  readonly modelSlug: string;
  readonly displayName: string;
  readonly inputPricePer1m: bigint;
  readonly outputPricePer1m: bigint;
  readonly cachedInputPricePer1m?: bigint;
}

/** The ~5 well-known draft rows (placeholder µUSD/1M; verify before billing). */
const DRAFT_PRICES: readonly DraftPrice[] = [
  {
    provider: 'openai',
    modelSlug: 'gpt-4o',
    displayName: 'GPT-4o',
    inputPricePer1m: 2_500_000n, // $2.50 / 1M
    outputPricePer1m: 10_000_000n, // $10.00 / 1M
    cachedInputPricePer1m: 1_250_000n,
  },
  {
    provider: 'openai',
    modelSlug: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    inputPricePer1m: 150_000n, // $0.15 / 1M
    outputPricePer1m: 600_000n, // $0.60 / 1M
  },
  {
    provider: 'anthropic',
    modelSlug: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    inputPricePer1m: 3_000_000n, // $3.00 / 1M
    outputPricePer1m: 15_000_000n, // $15.00 / 1M
  },
  {
    provider: 'anthropic',
    modelSlug: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    inputPricePer1m: 800_000n, // $0.80 / 1M
    outputPricePer1m: 4_000_000n, // $4.00 / 1M
  },
  {
    provider: 'google',
    modelSlug: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    inputPricePer1m: 100_000n, // $0.10 / 1M
    outputPricePer1m: 400_000n, // $0.40 / 1M
  },
];

/** The `(provider, slug)` pairs this seed inserts (a stable list for tooling/tests). */
export const OFFICIAL_PRICE_SEED_KEYS: readonly string[] = DRAFT_PRICES.map(
  (p) => `${p.provider}/${p.modelSlug}`,
);

/**
 * Idempotently insert the DRAFT official-price catalog rows. Find-then-create on
 * the live `(provider, slug)` pair, so a second run is a no-op (and an admin's
 * edits to an already-seeded row are never clobbered). Network-free.
 */
export async function seedOfficialPrices(db: Database): Promise<void> {
  for (const p of DRAFT_PRICES) {
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
      notes: DRAFT_NOTE,
    });
  }
}

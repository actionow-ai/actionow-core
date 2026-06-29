import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOfficialPrice,
  type Database,
  getOfficialPrice,
  normalizeModelSlug,
  upsertModelSpec,
} from '@actionow/db';

/**
 * 接入与供给 — import the OFFICIAL normalized model catalog as DATA.
 *
 * Reads the already-produced + committed dataset
 * `docs/research/official-model-catalog-normalized.json` (236 models, money in
 * integer µUSD-per-1M) and:
 *
 *   - upserts EVERY model into `model_spec` (the full vendor catalog — what each
 *     model IS, with sourcing `confidence`), and
 *   - for the firstparty per-token (`billingEligible`) models ONLY, mirrors the
 *     trustworthy COST BASIS into `official_model_price` so the matcher can
 *     auto-price discovered models off it. Every non-eligible row stays
 *     catalog-only (needs-review) and is NEVER billable.
 *
 * Idempotent + network-free: `model_spec` upserts on `(vendor, model_id)`; the
 * official price is skipped when a LIVE `(provider, normalizedSlug)` row already
 * exists. If the JSON is absent (e.g. `docs/` excluded from a slim image) the
 * importer LOGS a warning and returns `{0, 0}` — it MUST NOT throw, so the
 * Docker migrate/seed step never fails on its absence.
 */

/** The shape of one entry in the normalized catalog's `models` array (loose; only the fields we read). */
interface CatalogModel {
  readonly vendor: string;
  readonly modelId: string;
  readonly displayName?: string | null;
  readonly type: string;
  readonly inputModalities?: string[] | null;
  readonly outputModalities?: string[] | null;
  readonly mediaOptions?: unknown;
  readonly keyParams?: string[] | null;
  readonly status?: string | null;
  readonly contextWindow?: string | null;
  readonly maxOutput?: string | null;
  readonly intro?: string | null;
  readonly sources?: string[] | null;
  readonly confidence: string;
  readonly billingEligible: boolean;
  readonly pricing: {
    readonly srcCurrency?: string | null;
    readonly inputPer1mUsd?: number | null;
    readonly outputPer1mUsd?: number | null;
    readonly cachedInputPer1mUsd?: number | null;
    readonly asOf?: string | null;
    readonly source?: string | null;
    readonly notes?: string | null;
  };
}

interface CatalogFile {
  readonly models: CatalogModel[];
}

/** Counts returned by {@link importCatalog}. */
export interface ImportCatalogResult {
  /** Number of `model_spec` rows upserted (= total models in the dataset). */
  readonly modelSpecs: number;
  /** Number of `official_model_price` rows present after import for the eligible models. */
  readonly officialPrices: number;
}

/**
 * Map a dataset `vendor` DISPLAY name (often a long CN string) onto the catalog
 * provider KEY used by `model_spec.vendor` / `official_model_price.provider`.
 * Matched by substring so the long bilingual display names resolve robustly.
 * Returns `undefined` for an unknown vendor (the model is then skipped + counted
 * separately by the caller's log).
 */
export function providerKeyFor(vendor: string): string | undefined {
  if (vendor.includes('OpenAI')) return 'openai';
  if (vendor.includes('Anthropic')) return 'anthropic';
  if (vendor.includes('Google')) return 'google';
  if (vendor.includes('xAI')) return 'xai';
  if (vendor.includes('DeepSeek')) return 'deepseek';
  if (vendor.includes('Zhipu')) return 'zhipu';
  if (vendor.includes('Moonshot')) return 'moonshot';
  if (vendor.includes('MiniMax')) return 'minimax';
  if (vendor.includes('Volcengine') || vendor.includes('火山')) return 'volcengine';
  if (vendor.includes('Vidu') || vendor.includes('生数')) return 'vidu';
  if (vendor.includes('Kling') || vendor.includes('可灵')) return 'kling';
  return undefined;
}

const CATALOG_REL = join('docs', 'research', 'official-model-catalog-normalized.json');

/**
 * Robustly locate + read the catalog JSON. Walks up from this module's directory
 * (resolved via `import.meta.url`, so it works whether the seed runs from `src/`
 * via tsx with cwd=apps/api OR from a built `dist/`) AND from `process.cwd()`,
 * looking for `docs/research/official-model-catalog-normalized.json` at each
 * ancestor. Returns the parsed file, or `undefined` (with a warning) when not
 * found anywhere — the caller treats that as a no-op.
 */
function loadCatalog(): CatalogFile | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = new Set<string>();
  for (const start of [here, process.cwd()]) {
    let dir = start;
    // Up to 8 levels covers monorepo depth (apps/api/src/seed → repo root).
    for (let i = 0; i < 8; i++) {
      roots.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const root of roots) {
    const candidate = join(root, CATALOG_REL);
    try {
      const raw = readFileSync(candidate, 'utf8');
      return JSON.parse(raw) as CatalogFile;
    } catch {
      // Not at this ancestor (ENOENT) — keep walking.
    }
  }
  console.warn(
    `[seed-catalog] catalog JSON not found (looked for ${CATALOG_REL} up the tree from ` +
      `${here} and ${process.cwd()}); skipping catalog import.`,
  );
  return undefined;
}

/** Parse `asOf` (`2026-06`) into a Date for `effective_at`; undefined when absent/unparseable. */
function effectiveAtFrom(asOf: string | null | undefined): Date | undefined {
  if (asOf === null || asOf === undefined || asOf === '') return undefined;
  // Accept `YYYY-MM` (pin to the 1st) or any Date-parseable string.
  const iso = /^\d{4}-\d{2}$/.test(asOf) ? `${asOf}-01` : asOf;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Coerce a (possibly null) µUSD number to a bigint, or undefined. */
function microToBigint(n: number | null | undefined): bigint | undefined {
  if (n === null || n === undefined) return undefined;
  return BigInt(Math.round(n));
}

/**
 * Import the official normalized catalog (idempotent). See the module doc. Never
 * throws on a missing JSON file; returns the import counts.
 */
export async function importCatalog(db: Database): Promise<ImportCatalogResult> {
  const file = loadCatalog();
  if (file === undefined) return { modelSpecs: 0, officialPrices: 0 };

  const models = Array.isArray(file.models) ? file.models : [];
  let modelSpecs = 0;
  let officialPrices = 0;

  for (const m of models) {
    const vendorKey = providerKeyFor(m.vendor);
    if (vendorKey === undefined) {
      console.warn(`[seed-catalog] unknown vendor "${m.vendor}" (model ${m.modelId}); skipping.`);
      continue;
    }

    // EVERY model → model_spec (the full catalog; vendor=providerKey, raw modelId).
    await upsertModelSpec(db, {
      vendor: vendorKey,
      modelId: m.modelId,
      displayName: m.displayName ?? null,
      type: m.type,
      inputModalities: m.inputModalities ?? null,
      outputModalities: m.outputModalities ?? null,
      mediaOptions: m.mediaOptions ?? null,
      keyParams: m.keyParams ?? null,
      sources: m.sources ?? null,
      status: m.status ?? null,
      contextWindow: m.contextWindow ?? null,
      maxOutput: m.maxOutput ?? null,
      intro: m.intro ?? null,
      confidence: m.confidence,
      billingEligible: m.billingEligible,
      asOf: m.pricing.asOf ?? null,
      sourceUrl: m.pricing.source ?? null,
      notes: m.pricing.notes ?? null,
    });
    modelSpecs += 1;

    // Only the trustworthy firstparty per-token rows become a billable cost basis.
    if (!m.billingEligible) continue;
    const inputPricePer1m = microToBigint(m.pricing.inputPer1mUsd);
    const outputPricePer1m = microToBigint(m.pricing.outputPer1mUsd);
    if (inputPricePer1m === undefined || outputPricePer1m === undefined) {
      // A billing-eligible row with no per-token price is a dataset
      // inconsistency — never bill at 0; skip it (it stays in model_spec only).
      console.warn(
        `[seed-catalog] billingEligible model ${vendorKey}/${m.modelId} has no per-token price; ` +
          'not adding to official_model_price.',
      );
      continue;
    }
    const slug = normalizeModelSlug(m.modelId);
    // Idempotent: skip if a LIVE (provider, normalizedSlug) official price exists.
    // (getOfficialPrice additionally filters billing_eligible=true; the rows we
    // create here are all eligible, so a re-run still matches + skips.)
    if ((await getOfficialPrice(db, vendorKey, slug)) !== undefined) {
      officialPrices += 1;
      continue;
    }
    const cached = microToBigint(m.pricing.cachedInputPer1mUsd);
    await createOfficialPrice(db, {
      provider: vendorKey,
      modelSlug: slug,
      ...(m.displayName !== null && m.displayName !== undefined
        ? { displayName: m.displayName }
        : {}),
      inputPricePer1m,
      outputPricePer1m,
      ...(cached !== undefined ? { cachedInputPricePer1m: cached } : {}),
      currency: m.pricing.srcCurrency ?? 'USD',
      confidence: 'firstparty',
      billingEligible: true,
      ...(m.pricing.source !== null && m.pricing.source !== undefined
        ? { sourceUrl: m.pricing.source }
        : {}),
      ...(() => {
        const eff = effectiveAtFrom(m.pricing.asOf);
        return eff !== undefined ? { effectiveAt: eff } : {};
      })(),
      ...(m.pricing.notes !== null && m.pricing.notes !== undefined
        ? { notes: m.pricing.notes }
        : {}),
    });
    officialPrices += 1;
  }

  return { modelSpecs, officialPrices };
}

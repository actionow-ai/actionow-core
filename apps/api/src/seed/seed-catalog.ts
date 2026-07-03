import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_FEATURES, type ParameterRule } from '@actionow/contracts';
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

/**
 * Derive the model's fine-grained `features[]` (the Option-C single source that
 * drives BOTH `param_profile.features` AND the derived `capabilities` gate) from
 * the catalog fields the dataset already carries: `type`, `inputModalities`, and
 * the free-text `keyParams`. Modality-derived flags (vision/audio/file) are
 * exact; chat models (`text`/`multimodal`) get the near-universal
 * tool-call/json-object/stream base — being permissive there AVOIDS wrongly
 * 400-ing a tool/json request when the free-text keyParams simply didn't list
 * it; a keyParams substring scan then adds reasoning / structured-output /
 * parallel-tools / explicit vision. A first-cut derivation (no hand-curation) so
 * the 236 specs stop being empty; refine per-model later in 规格库 CRUD.
 */
export function catalogToFeatures(m: {
  readonly type?: string | null;
  readonly inputModalities?: string[] | null;
  readonly keyParams?: string[] | null;
}): string[] {
  const feats = new Set<string>();
  const type = (m.type ?? '').toLowerCase();
  const mods = m.inputModalities ?? [];
  const kp = (m.keyParams ?? []).join(' | ').toLowerCase();
  const isChat = type === 'text' || type === 'multimodal';
  if (isChat) {
    feats.add('tool-call');
    feats.add('json-object');
    feats.add('stream');
  }
  // Modality-derived (exact).
  if (mods.includes('image')) feats.add('vision');
  if (mods.includes('audio')) feats.add('audio');
  if (mods.includes('pdf')) feats.add('file');
  // keyParams substring scan.
  if (/tool|function.?call/.test(kp)) feats.add('tool-call');
  if (kp.includes('parallel')) feats.add('parallel-tool-call');
  if (/structured output|json.?schema/.test(kp)) {
    feats.add('json-schema');
    feats.add('json-object');
  }
  // POSITIVE reasoning signals only — a bare /thinking/ would match "non-thinking
  // mode only" (deepseek-chat) and wrongly strip temperature from a normal chat
  // model. `extended thinking (yes)` matches but `adaptive thinking (no)` does not.
  if (
    /reasoning_effort|reasoning\b|extended thinking \(yes\)|adaptive thinking \(yes\)|thinkingbudget|thinking budget|effort parameter/.test(
      kp,
    )
  ) {
    feats.add('reasoning');
  }
  if (/vision|image input/.test(kp)) feats.add('vision');
  if (/\bstream/.test(kp)) feats.add('stream');
  // Stable, canonical order.
  return MODEL_FEATURES.filter((f) => feats.has(f));
}

/**
 * Null-out a catalog free-text value that is a data-quality PLACEHOLDER rather
 * than real content, so a string like "Not stated on pricing page" never lands
 * verbatim in a `model_spec` TEXT column (where a UI shows it as fact and a
 * numeric parser gets NaN). A value that merely CONTAINS a number after a
 * placeholder lead-in is still dropped — an operator fills the real value in
 * 规格库 CRUD. Real content (anything not matching a placeholder phrase) passes
 * through unchanged.
 */
export function cleanCatalogText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  if (t === '') return null;
  // Leading placeholder phrases ("Not stated…", "Not explicitly stated…",
  // "N/A", "Unknown", "TBD", "Not specified/listed/published/disclosed").
  if (
    /^(not\s+(explicitly\s+)?(stated|specified|listed|published|disclosed|available)|n\/?a|unknown|tbd|none|not\s+applicable)\b/i.test(
      t,
    )
  ) {
    return null;
  }
  return s;
}

/**
 * Derive a coarse model `family` / series (`gpt-4o`, `claude-haiku-4-5`,
 * `gemini-2.5`) for catalog grouping + faceting by stripping a model id's
 * size/variant suffix (`-mini`/`-nano`/`-pro`/`-flash`/`-lite`/`-chat`/`-codex`/
 * `-preview`/`-latest`) and any trailing `-YYYYMMDD` date stamp. A first-cut
 * heuristic (no hand-curation) so the grouping stops being empty; refine in
 * 规格库 CRUD. Returns null only for an empty id.
 */
export function familyFrom(modelId: string): string | null {
  const id = modelId.trim();
  if (id === '') return null;
  const family = id
    // trailing date stamp (claude-haiku-4-5-20251001 → claude-haiku-4-5)
    .replace(/-\d{6,8}$/, '')
    // trailing size/variant suffixes (repeatable: gemini-2.5-flash-lite → gemini-2.5)
    .replace(/-(mini|nano|pro|flash|lite|chat|codex|preview|latest|thinking|instruct|base)$/gi, '')
    .replace(/-(mini|nano|pro|flash|lite|chat|codex|preview|latest|thinking|instruct|base)$/gi, '');
  return family === '' ? id : family;
}

/**
 * Derive a conservative, VALIDATION-ONLY `parameter_rules` contract for a CHAT
 * model from the fields the dataset already carries (`type` + free-text
 * `keyParams` + derived `features`). Every rule declares only its type + bounds /
 * enum options — NEVER a `default` — so the engine's stage-① default injection
 * (which fires only for rules carrying a `default`) stays a no-op: no value is
 * ever injected when a caller omits a param.
 *
 * REASONING GUARD (the regression invariant): `parameter_rules` doubles as the
 * allow-list for `llm-protocol/normalize.downgradeByProfile`, which strips the
 * sampling knobs a reasoning model rejects (`temperature`/`top_p`/`stop` +
 * `frequency_penalty`/`presence_penalty`). Declaring one of those for a reasoning
 * model would ADD it to the allow-list and STOP the strip — changing today's
 * behavior. So those knobs are declared ONLY for NON-reasoning models; a reasoning
 * model keeps its blanket sampling-strip byte-for-byte. The always-safe knobs
 * (`top_k`/`max_tokens`/`reasoning_effort`/`response_format` — none in the strip
 * set) are declared for every chat model.
 *
 * Rules add clamp/validation governance + a real "允许参数" list to the 规格库 UI,
 * driven strictly by what each model self-declares. Non-chat models (image/video/
 * audio) get no rules. First-cut; refine in 规格库 CRUD.
 */
export function catalogToParameterRules(m: {
  readonly type?: string | null;
  readonly inputModalities?: string[] | null;
  readonly keyParams?: string[] | null;
}): ParameterRule[] {
  const type = (m.type ?? '').toLowerCase();
  if (type !== 'text' && type !== 'multimodal') return [];
  const kp = (m.keyParams ?? []).join(' | ').toLowerCase();
  const feats = new Set(catalogToFeatures(m));
  const isReasoning = feats.has('reasoning');
  const has = (re: RegExp): boolean => re.test(kp);
  const rules: ParameterRule[] = [];
  // Reasoning-strip-set knobs — declared for NON-reasoning models only (see the
  // REASONING GUARD above), so a reasoning model's downgrade is unchanged.
  if (!isReasoning) {
    if (has(/temperature/)) rules.push({ name: 'temperature', type: 'float', min: 0, max: 2 });
    if (has(/top[-_ ]?p|nucleus/)) rules.push({ name: 'top_p', type: 'float', min: 0, max: 1 });
    if (has(/frequency[-_ ]?penalty/)) {
      rules.push({ name: 'frequency_penalty', type: 'float', min: -2, max: 2 });
    }
    if (has(/presence[-_ ]?penalty/)) {
      rules.push({ name: 'presence_penalty', type: 'float', min: -2, max: 2 });
    }
  }
  // Always-safe knobs (not in the reasoning strip-set) — validation only.
  if (has(/top[-_ ]?k/)) rules.push({ name: 'top_k', type: 'int', min: 1 });
  if (has(/max[-_ ]?(tokens|output|completion)|output[-_ ]?tokens/)) {
    rules.push({ name: 'max_tokens', type: 'int', min: 1 });
  }
  if (isReasoning || has(/reasoning[-_ ]?effort/)) {
    // Parse explicit options from a keyParams entry like
    // "reasoning_effort (minimal/low/medium/high)"; else the canonical set.
    const rawOpts = /reasoning[-_ ]?effort\s*\(([^)]+)\)/i.exec(kp)?.[1];
    const parsed = rawOpts
      ? rawOpts
          .split(/[/,|]/)
          .map((o) => o.trim())
          .filter((o) => o.length > 0)
      : [];
    const options = parsed.length > 0 ? parsed : ['minimal', 'low', 'medium', 'high'];
    rules.push({ name: 'reasoning_effort', type: 'enum', options });
  }
  if (
    feats.has('json-schema') ||
    feats.has('json-object') ||
    has(/structured output|json[-_ ]?schema|response[-_ ]?format|json mode/)
  ) {
    rules.push({
      name: 'response_format',
      type: 'enum',
      options: ['text', 'json_object', 'json_schema'],
    });
  }
  return rules;
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
      // Derived series/family grouping (was NULL for every row → empty facets).
      family: familyFrom(m.modelId),
      type: m.type,
      inputModalities: m.inputModalities ?? null,
      outputModalities: m.outputModalities ?? null,
      mediaOptions: m.mediaOptions ?? null,
      keyParams: m.keyParams ?? null,
      // Derived fine-grained features (mig 0063) — the single source the sync/seed
      // path projects into `capabilities` and freezes into `param_profile`.
      features: catalogToFeatures(m),
      // Derived VALIDATION-ONLY param contract (mig 0063/0064; was NULL for every
      // row → param governance silently off). No rule carries a `default`, so no
      // value is injected on omission; an in-range request is unchanged and the
      // reasoning sampling-strip is preserved (see catalogToParameterRules). The
      // only new effect is defensive clamping of an OUT-of-range value.
      parameterRules: catalogToParameterRules(m),
      sources: m.sources ?? null,
      status: m.status ?? null,
      // Null-out placeholder strings ("Not stated on pricing page") so they never
      // land verbatim in a TEXT column shown as fact / parsed as a number.
      contextWindow: cleanCatalogText(m.contextWindow),
      maxOutput: cleanCatalogText(m.maxOutput),
      intro: cleanCatalogText(m.intro),
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

<!-- Generated 2026-06-30 by an 11-vendor catalog-gather workflow (official pricing pages). 236 models.
     Full structured data: official-model-catalog-2026.json. Prices carry asOf+source; treat as NEEDS-VERIFICATION before billing. -->

# Official Multi-Vendor Model Catalog — Pricing Data-Model Design Report

## 1. Coverage Overview

| Vendor | #Models | Types offered | Currency | Notable coverage gaps |
|---|---:|---|---|---|
| OpenAI | 31 | text, image, video, audio, multimodal | USD | Legacy 4.x/o-series retired (no fabricated prices); embeddings/TTS/moderation secondary-sourced; deep-research/computer-use only Batch-column captured; context/max-output not enumerated for 5.x; gpt-5.4-cyber no price |
| Anthropic | 13 | text only | USD | No image/video/audio (intentional). Sonnet 4.5/4 >200k premium rates not surfaced verbatim; retired-model context/max-output approximated; Bedrock/GCP pricing deferred |
| Google (Gemini) | 23 | text, image, video, audio, multimodal | USD | Veo 3.1 with/without-audio per-second split ambiguous; Live/Computer-Use/Lyria-RealTime standalone rates not all surfaced; agent endpoints omitted; image models bill by underlying output tokens |
| xAI | 12 | text, image, video, audio | USD | Cache-write not published (read-only); batch % not published; image/video param matrices empty (flat); max-output not published; voice services lack real API slugs |
| DeepSeek | 4 | text only | USD (+CNY ref) | No image/video/audio/embedding (intentional). CNY medium-confidence (stale official page); off-peak program ended; CoT cap unpublished |
| Zhipu (GLM) | 44 | text, image, video, audio, multimodal | USD + CNY | bigmodel.cn CNY page JS-only → many CNY figures secondary; no resolution/duration matrix for media (flat); GLM-Z1 absent (superseded) |
| Moonshot (Kimi) | 18 | text, multimodal | USD (+CNY) | No image/video/audio/embedding/moderation (intentional). Max-output unpublished; deprecated-model prices unconfirmed; batch/web-search extras unconfirmed |
| MiniMax | 20 | text, image, video, audio, multimodal | USD | speech-2.6/02 per-char rates inferred; Hailuo-02 per-clip by point-parity; M3 media-input surcharge not verbatim; subscription/package tracks not modeled as per-unit |
| Volcengine (Doubao) | 32 | text, image, video, audio, multimodal | CNY | Prices from mirrored markdown (JS-rendered console); 2.1 higher tiers not found verbatim; model-id date suffixes unconfirmed; audio sold via resource packages (no single list rate); video = tokens-from-resolution formula |
| Vidu | 22 | video, image, audio, text | USD (.cn CNY unconfirmed) | .cn RMB-per-credit unconfirmed; Q1-classic cost not broken out; one Q2 base+per-sec cell ambiguous; vidu1.5 omitted (unconfirmed) |
| Kling (Kuaishou) | 18 | video, image, audio | USD + CNY | **No price read verbatim (HTTP 446)** — all reconstructed from guides/resellers/aggregators; many exact first-party rates unconfirmed; aggregator multiplier model is third-party logic |

**Cross-vendor gaps:** (a) **Context-window / max-output** missing for most text models (OpenAI 5.x, retired Anthropic, xAI all). (b) **Cache-write** pricing frequently unpublished (xAI, Moonshot V1, DeepSeek). (c) **Media parameter matrices** (resolution×duration×mode) are often collapsed to flat per-unit because vendors don't publish the grid (xAI, Zhipu, MiniMax speech). (d) **CNY** figures for CN vendors are largely secondary (JS-rendered pages). (e) **Tools** (web search, grounding, code execution) are billed per-call but are NOT models — must be modeled separately. (f) **Multi-currency**: USD dominant, but DeepSeek/Zhipu/Doubao/Kling carry CNY — schema must be currency-aware.

---

## 2. Pricing-Shape Taxonomy

Distinct billing patterns observed, with users and required fields:

| # | Pattern | Vendors / types | Fields needed |
|---|---|---|---|
| **P1** | **Per-token (flat)** input/output per-1M | OpenAI 5.x/embeddings/transcribe; Anthropic Haiku; Gemini Flash/Flash-Lite; xAI all text; DeepSeek; Zhipu text; Moonshot K2.x/V1; MiniMax M2.x | `inputPer1M`, `outputPer1M` |
| **P2** | **Per-token + cache** (read, and sometimes write) | OpenAI 5.x/image/realtime; Anthropic (read 0.1×, 5-min write 1.25×, 1-hr write 2×); Gemini paid; xAI (read-only $0.20); DeepSeek (hit/miss split); Zhipu; Moonshot K2.x; MiniMax | `cacheReadPer1M`, `cacheWrite5mPer1M`/`cacheWrite1hPer1M` **or** multiplier-on-input; plus storage fee (Doubao) |
| **P3** | **Tiered-by-context-length** (≥200k or ≤32k/>32k bands; whole request priced by input band) | Gemini 3.1 Pro / 2.5 Pro (200k); Anthropic Sonnet 4.5/4 (>200k premium); Zhipu GLM-5.1 (≤32K/>32K); MiniMax M3 (≤512k/>512k); Doubao Seed (0-32K/32K-128K/128K-256K) | `tiers[]` keyed on `inputTokens` boundary → per-tier input/output |
| **P4** | **Context-band SKU tiers (8k/32k/128k)** as distinct priced models/sub-tiers | Moonshot V1 (8k/32k/128k) + `moonshot-v1-auto` router | `tiers[]` keyed on context band, or separate model ids |
| **P5** | **Batch / Flex discount** (~20–50% off) | OpenAI (50%); Anthropic (50%); Gemini (~50% Batch, ~1.8× Priority); xAI (20–50%); Zhipu/Moonshot/MiniMax/Doubao (~50%, sometimes ~40%) | `lanes[]` / multiplier per lane (`standard`/`batch`/`priority`/`flex`) |
| **P6** | **Off-peak / time-of-day discount** | Vidu (off-peak = ½); (DeepSeek historical, now ended) | time-window predicate + multiplier |
| **P7** | **Regional / data-residency uplift** | OpenAI (+10% post-2026-03-05); Anthropic (1.1× us; +10% cloud); Kling/CN multi-region | `regionMultipliers{}` |
| **P8** | **Fast/high-speed mode** (premium or 2× rate) | Anthropic Fast Mode (Opus); Moonshot/MiniMax `-highspeed` (2×); Gemini Priority | mode multiplier or separate SKU |
| **P9** | **Per-image flat** | OpenAI(token-equiv); Gemini Imagen; xAI; Zhipu GLM-Image/CogView; MiniMax image-01; Doubao Seedream | `perImage` |
| **P10** | **Per-image matrix (size × quality)** | OpenAI GPT-Image (size×quality); Gemini image (per-resolution); Zhipu (declared matrix); Kling (1K/4K) | `paramMatrix[]` keyed `{size, quality}` → price |
| **P11** | **Per-second video (flat)** | OpenAI sora-2; Gemini Veo (with res band); xAI imagine-video; Kling per-sec; Vidu utilities | `perSecond` (optionally per-resolution) |
| **P12** | **Video matrix (resolution × duration × mode/audio)** | OpenAI sora-2-pro; Gemini Veo 3.1 (res × audio × fast); MiniMax Hailuo (res×dur); Kling v3/v2.6/v2.1 (audio/voice-control); xAI grok-stt | `paramMatrix[]` keyed `{resolution, duration, mode, audio}` |
| **P13** | **Per-second + base** (base credits + per-sec) | Vidu Q2 family | `base` + `perSecond` |
| **P14** | **Video billed as tokens-from-media** (tokens estimated from res×fps×duration, then per-1M) | Doubao Seedance (+ draft-mode coefficient) | formula `tokens = f(res,fps,dur)` + `per1M` + `draftCoefficient` |
| **P15** | **Credits-based** (units × $/credit, round-up, +add-ons) | Vidu (1 credit=$0.005, +15 audio); Kling (¥1/credit, std~2/s pro~7/s) | `credits` (from matrix) × `creditValue` + `addOnCredits`, `roundingMode` |
| **P16** | **Per-character audio (TTS)** | OpenAI tts-1/hd; xAI grok-tts; Zhipu GLM-TTS; MiniMax speech-2.x; Vidu TTS | `perCharacter` (or per-1M-chars) |
| **P17** | **Per-minute audio** | OpenAI realtime-translate/whisper; xAI grok-voice; Zhipu GLM-Realtime/Voice; Doubao ASR | `perMinute` (optionally matrix by quality, e.g. grok-voice) |
| **P18** | **Per-token audio** (duration-encoded tokens) | OpenAI gpt-realtime-2 / 4o-transcribe (tiered); Gemini TTS/Live (tiered); Zhipu GLM-ASR | `inputPer1M`/`outputPer1M` with audio-token split |
| **P19** | **Per-request / per-track / per-song** | OpenAI moderation; Gemini Lyria (per-song matrix); Zhipu CogVideoX/Vidu (per-video); MiniMax music/lyrics; Vidu voice-clone | `perRequest` (optionally matrix) |
| **P20** | **Resource-package / subscription / "other"** | Doubao TTS/ASR (字数包/时长包/并发包); MiniMax video/audio packages; Kling prepaid packs | package model: `units`, `bundlePrice`, `validityDays` — out of per-unit billing path |
| **P21** | **Free** | OpenAI moderation; Gemini/Zhipu Flash free tiers; Kling failed-task no-charge | `free: true` |

**Orthogonal modifiers** (stack on any base pattern, NOT separate schemes): cache (P2), lane/batch (P5), off-peak (P6), region (P7), fast-mode (P8), audio add-on (P12/P15), tokenizer inflation (Anthropic 4.7+). These must be representable as **multipliers/adders layered on top of the base price**, not new union arms.

---

## 3. Unified Pricing Schema Sketch

One discriminated union by `method`, with shared `tiers[]`, `paramMatrix[]`, `cache`, `modifiers`, `currency`, and effective-dating. All money in **µUSD** (the repo's existing `µUSD` money unit) after FX normalization; `srcAmount`/`srcCurrency` preserve the vendor-quoted figure.

```ts
type Money = number;            // integer µUSD (existing unit); convert CNY via fxRateRef
type Per1M  = Money;            // price per 1,000,000 units (tokens/chars)

interface PricePoint {          // a single (input,output[,cache]) bundle
  inputPer1M?:  Per1M;          // P1/P3/P4/P18
  outputPer1M?: Per1M;
  perImage?:    Money;          // P9
  perSecond?:   Money;          // P11/P13
  perMinute?:   Money;          // P17
  perChar?:     Money;          // P16 (or perCharPer1M)
  perRequest?:  Money;          // P19/P20
  credits?:     number;         // P15 (× creditValueµUSD)
  baseCredits?: number;         // P13/P15 add-on base
  free?:        boolean;        // P21
}

interface CacheSpec {           // P2 — absolute rates OR multipliers on input
  readPer1M?: Per1M;     readMult?: number;          // 0.1× (Anthropic)
  write5mPer1M?: Per1M;  write5mMult?: number;       // 1.25×
  write1hPer1M?: Per1M;  write1hMult?: number;       // 2×
  storagePer1MPerHour?: Per1M;                        // Doubao
}

interface Tier {                // P3/P4/P18 — context/usage bands
  dim: 'inputTokens' | 'contextWindow';
  from: number; to?: number;     // [from,to) band; whole request priced by band
  price: PricePoint;
}

interface MatrixAxis { key: string; values: (string|number)[]; }  // e.g. {key:'resolution',values:['720p','1080p','4k']}
interface MatrixCell {          // P10/P12/P14/P19 — paramMatrix
  match: Record<string, string|number>;   // {resolution:'1080p', duration:6, audio:true}
  price: PricePoint;
  tokenFormula?: string;                   // P14: "round(w*h*fps*dur/k)" → tokens, then × per1M
}

interface Modifier {            // P5–P8 — stacking multipliers/adders
  kind: 'lane'|'offpeak'|'region'|'mode'|'tokenizerInflation';
  id: string;                                 // 'batch'|'priority'|'us'|'fast'|'highspeed'
  mult?: number; addPer1M?: Per1M; addCredits?: number;
  predicate?: { timeWindow?: [string,string]; region?: string; releasedOnAfter?: string };
}

type PricingScheme =
  | { method: 'unit';     base: PricePoint; cache?: CacheSpec; tiers?: Tier[] }        // P1,P2,P3,P4,P16,P17,P18
  | { method: 'matrix';   axes: MatrixAxis[]; cells: MatrixCell[]; cache?: CacheSpec } // P10,P12,P14,P19
  | { method: 'fixed';    base: PricePoint }                                           // P9,P11,P19 flat, P21 free
  | { method: 'credits';  creditValueµUSD: Money; axes?: MatrixAxis[]; cells?: MatrixCell[];
                          base?: PricePoint; addOns?: {id:string; credits:number}[];
                          roundingMode: 'up'|'nearest' }                               // P13,P15
  | { method: 'formula';  expr: string; vars: string[]; cache?: CacheSpec }            // escape hatch (Doubao token-from-media)
  | { method: 'passthrough'; note: string }                                           // P20 packages / unpriced
  | { method: 'model_token'; modelRef: string };                                       // alias → another model's price

interface OfficialPrice {       // the billing record (cost basis for auto-pricing)
  modelId: string; vendor: string;
  scheme: PricingScheme;
  modifiers?: Modifier[];                      // batch/region/offpeak/fast stack on scheme
  currency: 'USD'|'CNY';                       // source currency
  fxRateRef?: string;                          // normalization to µUSD if CNY
  confidence: 'firstparty'|'secondary'|'reconstructed';   // Kling=reconstructed, etc.
  effectiveFrom: string; effectiveTo?: string; // effective-dating (price revisions)
  supersedesId?: string;                       // price-history chain
  sourceUrl?: string; asOf: string; notes?: string;
}
```

### Mapping onto the existing pricebook & `official_model_price`

The existing pricebook methods (`unit | matrix | fixed | formula | passthrough | model_token`) are **preserved verbatim** as the `method` discriminant — this design is a superset, not a rewrite:

- `unit` — **extended** with `cache?: CacheSpec` and `tiers?: Tier[]` (today it's flat in/out). Covers P1–P4, P16–P18.
- `matrix` — **extended** from implicit grid to explicit `axes[]` + `cells[]` so size×quality and resolution×duration×audio are machine-evaluable (P10/P12).
- `fixed` — unchanged (P9 flat per-image, P11 flat per-second, P21 free via `free:true`).
- `formula` — unchanged escape hatch; now the home for Doubao's tokens-from-media (P14) with `tokenFormula`/`expr`.
- `passthrough` — unchanged; now also covers resource-package/subscription tracks (P20) and unpriced/reconstructed-gap models.
- `model_token` — unchanged; now formalizes vendor **aliases** (`gpt-3-pro-preview→3.1`, `deepseek-chat→V4-Flash`, xAI retired→`grok-4.3`).
- **NEW** `credits` arm — required because Vidu/Kling credit billing (units × creditValue + round-up + add-ons) doesn't fit `unit`/`matrix` cleanly (P13/P15).

`official_model_price` today has only `input_price_per_1m` / `output_price_per_1m`. **Migration path (additive, non-breaking):** keep those two columns as the **denormalized fast-path for the common `unit`-flat case** (auto-pricing reads them directly for P1 text models), and add a `scheme jsonb` column holding the full `PricingScheme` above for everything else. Add `currency`, `fx_rate_ref`, `effective_from`/`effective_to`, `supersedes_id`, `confidence`, `source_url`, `as_of`. The billing engine resolves: if `scheme` is null → use the two legacy columns as a `unit` scheme; else evaluate `scheme`. This keeps `µUSD` as the money unit, slots into the existing `official price → auto-pricing → group_ratio/per-channel margin` chain, and lets the records-system/audit_log capture price revisions via the `supersedes_id` effective-dating chain.

---

## 4. Catalog (Non-Pricing) Schema Sketch

The model-spec record, decoupled from pricing (joined by `modelId`):

```ts
interface ModelSpec {
  // identity
  modelId: string;              // canonical vendor slug, e.g. 'gpt-5.5', 'claude-opus-4-8'
  vendor: string;               // 'OpenAI' | 'Anthropic' | 'Google' | 'xAI' | ...
  family: string;               // 'GPT-5', 'Claude Opus', 'Gemini 3', 'Seed', 'Vidu Q3'
  displayName: string;          // 'GPT-5.5', 'Claude Opus 4.8'
  aliases: string[];            // ['opus'], ['gemini-3-pro-preview'→…], dateless↔dated
  aliasOf?: string;             // if this id resolves to another (pointer/alias)

  // classification
  type: 'text'|'image'|'video'|'audio'|'multimodal';
  modalities: { input: Modality[]; output: Modality[] };   // ['text','image']→['text']
  capabilities?: string[];      // ['vision','reasoning','thinking-mode','tool-use','batch','caching']

  // lifecycle
  status: 'ga'|'preview'|'limited'|'legacy'|'deprecated'|'retired'|'free';
  releasedAt?: string;
  deprecatedAt?: string; retiresAt?: string;               // e.g. Opus 4.1 retires 2026-08-05
  migrationTarget?: string;     // retired→successor slug (xAI→grok-4.3)

  // text envelope (null for pure media)
  contextWindow?: number;       // 200k / 1M (nullable — often unpublished)
  maxOutputTokens?: number;
  longContext?: { boundary: number; pricedAtStandard: boolean };  // 1M-at-standard flag

  // media envelope (null for pure text)
  mediaOptions?: {
    resolutions?: string[];     // ['720p','1080p','4k']
    durationsSec?: number[];    // [4,6,8,10]
    sizes?: string[];           // image sizes ['1024x1024',...]
    qualities?: string[];       // ['standard','hd']
    aspectRatios?: string[];
    modes?: string[];           // ['t2v','i2v','reference','draft','audio']
    fps?: number[];
    maxDurationSec?: number;
    voices?: string[];          // TTS
  };

  // key params surfaced to callers
  keyParams?: { name: string; type: string; default?: unknown; range?: [number,number] }[];

  // provenance / docs
  intro?: string;               // one-line description
  sources: string[];            // first-party doc URLs
  confidence: 'firstparty'|'secondary'|'reconstructed';
  asOf: string;                 // data snapshot date
  effectiveFrom?: string; effectiveTo?: string;            // spec-level dating
  notes?: string;               // per-model caveats (uncertainty flags from coverageNotes)
}

type Modality = 'text'|'image'|'audio'|'video';
```

**Notes:** `type` is the coarse UI bucket; `modalities` is the precise truth (`multimodal` = image/video input → text output for Kimi/GLM-V). `status` drives catalog visibility and routing eligibility (retired→`migrationTarget` resolved like the pricing `model_token` arm). `confidence`/`sources`/`asOf` preserve the faithfulness flags from each vendor's coverageNotes (critical for Kling=`reconstructed`, CN-CNY=`secondary`). `mediaOptions` feeds the pricing `MatrixAxis.values` so the catalog and the price matrix stay aligned. Both `ModelSpec` and `OfficialPrice` carry effective-dating so spec changes and price revisions are independently versioned and auditable.
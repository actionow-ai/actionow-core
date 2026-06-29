#!/usr/bin/env node
// normalize-catalog.mjs
//
// DATA GOVERNANCE: turn the raw gathered model-pricing catalog
// (docs/research/official-model-catalog-2026.json) into a normalized,
// billing-ready dataset in µUSD with per-model confidence + billing eligibility.
//
// Node ESM, builtins ONLY (no external deps). Deterministic + idempotent:
// same input always produces byte-identical output.
//
// FAITHFULNESS CONTRACT (the normalized data drives billing, so WRONG > MISSING):
//   - never invent or average a price.
//   - if a price string cannot be parsed to a single scalar, set the scalar
//     to null, keep the verbatim source, and attach a normalizeNote.
//   - confidence is assigned conservatively; when unsure, DOWNGRADE.
//
// Money unit: 1 USD = 1_000_000 µUSD.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "docs/research/official-model-catalog-2026.json");
const OUT = resolve(ROOT, "docs/research/official-model-catalog-normalized.json");

// ---------------------------------------------------------------------------
// FX. The source mixes USD and CNY. We convert CNY -> USD at a single,
// documented, fixed rate so the normalized µUSD figures are reproducible.
// This is a normalization-time assumption, NOT a live FX feed; CN-vendor prices
// converted this way are flagged confidence:'secondary' (never billingEligible).
const CNY_PER_USD = 7.2; // 1 USD = 7.2 CNY (documented fixed normalization rate)

const USD_TO_UUSD = 1_000_000; // 1 USD = 1e6 µUSD

// Official first-party domains per firstparty-eligible vendor. A model is only a
// firstparty candidate when its price source URL lives on one of these domains.
const OFFICIAL_DOMAINS = {
  OpenAI: ["openai.com"],
  Anthropic: ["anthropic.com", "claude.com"],
  Google: ["ai.google.dev", "google.dev", "cloud.google.com"],
  xAI: ["x.ai"],
  DeepSeek: ["deepseek.com"],
};

const FIRSTPARTY_VENDORS = new Set(Object.keys(OFFICIAL_DOMAINS));

// Token-based schemes that are eligible to become billingEligible.
const TOKEN_SCHEMES = new Set(["per-1m-tokens", "tiered-tokens"]);

// Precise reconstruction-trigger keywords (per the governance spec):
// reconstructed / HTTP 446 / aggregator / reseller(s). NOTE: "secondary" and
// "JS-rendered" are deliberately NOT here — those push toward `secondary`
// confidence, not `reconstructed`.
const RECON_RE = /reconstruct|http\s*446|\b446\b|aggregator|reseller/i;

// ---------------------------------------------------------------------------
// helpers

// canonical short vendor key (used for rules / OFFICIAL_DOMAINS lookup)
function vendorKey(vendorName) {
  if (/^OpenAI/i.test(vendorName)) return "OpenAI";
  if (/^Anthropic/i.test(vendorName)) return "Anthropic";
  if (/^Google/i.test(vendorName)) return "Google";
  if (/^xAI/i.test(vendorName)) return "xAI";
  if (/^DeepSeek/i.test(vendorName)) return "DeepSeek";
  if (/Zhipu/i.test(vendorName)) return "Zhipu";
  if (/Moonshot/i.test(vendorName)) return "Moonshot";
  if (/MiniMax/i.test(vendorName)) return "MiniMax";
  if (/Volcengine|火山/i.test(vendorName)) return "Volcengine";
  if (/Vidu|生数/i.test(vendorName)) return "Vidu";
  if (/Kling|可灵/i.test(vendorName)) return "Kling";
  return vendorName;
}

function isFreeString(s) {
  return typeof s === "string" && /^\s*free\s*$/i.test(s.trim());
}

function isMissingString(s) {
  if (s == null) return true;
  if (typeof s !== "string") return true;
  const t = s.trim();
  if (t === "") return true;
  return /not stated|not explicitly|unconfirmed|n\/a\b|^n\/a/i.test(t);
}

function hostOf(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^[a-z]+:\/\/([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function onOfficialDomain(url, vendor) {
  const host = hostOf(url);
  if (!host) return false;
  const domains = OFFICIAL_DOMAINS[vendor];
  if (!domains) return false;
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// Count how many distinct numeric "$X" or "X 元/¥" magnitudes a string mentions.
// Used to decide whether a media-unit string carries a SINGLE unambiguous scalar
// (parseable) vs MULTIPLE rates (ambiguous -> null + note, never averaged).
function distinctNumbers(s) {
  if (typeof s !== "string") return [];
  const nums = [];
  const re = /\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) nums.push(n);
  }
  return nums;
}

// Detect currency from a verbal price string. Returns "CNY" | "USD" | null.
function detectCurrency(s, fallback) {
  if (typeof s === "string") {
    if (/[¥￥]|元|人民币|RMB|CNY/i.test(s)) return "CNY";
    if (/\$|USD|dollar/i.test(s)) return "USD";
  }
  return fallback || null;
}

// Convert a USD-or-CNY scalar (raw number) into µUSD.
function toUuusd(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  let usd = amount;
  if (currency === "CNY") usd = amount / CNY_PER_USD;
  return Math.round(usd * USD_TO_UUSD);
}

// ---------------------------------------------------------------------------
// PER-1M / TIERED TOKEN price parsing.
//
// Returns { uusdPer1m, srcAmount, srcCurrency, note } where uusdPer1m is the
// µUSD-per-1M-tokens scalar (or null) and srcAmount is the verbatim number.
//
// Handles the verbal variants observed in the source:
//   "$5.00 / 1M tokens", "$5.00/1M tokens", "$5.00 per 1M tokens",
//   "$3 / MTok", "$0.3 / M tokens", "$0.95 per 1M tokens (cache miss)",
//   "6 元 / 百万 tokens", "3.20 元 / 百万 tokens (...)", "¥X / 1M".
function parseTokenPrice(raw, fallbackCurrency) {
  if (isMissingString(raw)) {
    return { uusdPer1m: null, srcAmount: null, srcCurrency: null, note: raw == null ? "missing price" : "price not stated" };
  }
  if (isFreeString(raw)) {
    return { uusdPer1m: 0, srcAmount: 0, srcCurrency: detectCurrency(raw, fallbackCurrency) || "USD", note: "free" };
  }

  const currency = detectCurrency(raw, fallbackCurrency) || "USD";

  // Grab the FIRST numeric magnitude attached to a per-(1M|M|MTok|百万) token unit.
  // We anchor on the unit to avoid grabbing a stray number from a parenthetical.
  // USD forms: $X / 1M | $X/1M | $X per 1M | $X / M tokens | $X / MTok
  // CNY forms: X 元 / 百万 | ¥X / 1M | X 元/百万
  let amount = null;

  // USD: dollar sign then number, followed (anywhere after) by a per-million unit.
  let m =
    raw.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1\s*m\b|1\s*million|\bm\b|mtok|million)/i) ||
    // CNY: number then 元 then /百万 (or just 元 / 百万 tokens)
    raw.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*元\s*\/?\s*百万/i) ||
    // ¥ / RMB explicit symbol then number then per-million
    raw.match(/[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1\s*m\b|百万|million)/i);

  if (m) {
    amount = Number(m[1].replace(/,/g, ""));
  } else {
    // Last-resort: a leading "$X" or "X 元" with NO recognizable unit nearby.
    // We do NOT trust this for token scheme -> leave null + note (faithful).
    return {
      uusdPer1m: null,
      srcAmount: null,
      srcCurrency: currency,
      note: "token price present but per-million unit not unambiguously parseable; left null",
    };
  }

  if (!Number.isFinite(amount)) {
    return { uusdPer1m: null, srcAmount: null, srcCurrency: currency, note: "token price number unparseable; left null" };
  }

  return {
    uusdPer1m: toUuusd(amount, currency),
    srcAmount: amount,
    srcCurrency: currency,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// MEDIA-UNIT price parsing (per-image / per-second / per-minute / per-character
// / per-request). Captures { unit, srcAmount (verbatim string), srcCurrency,
// usd (µUSD scalar if a SINGLE number parses, else null) }.
function parseMediaPrice(scheme, pricing) {
  const unitMap = {
    "per-image": "image",
    "per-second": "second",
    "per-minute": "minute",
    "per-character": "character",
    "per-request": "request",
  };
  const unit = unitMap[scheme] || scheme;

  // Prefer the `input` string (most media models put the rate there); some carry
  // it in `output`. We capture the verbatim source either way.
  const candidates = [];
  if (typeof pricing.input === "string") candidates.push(pricing.input);
  if (typeof pricing.output === "string" && pricing.output !== pricing.input) candidates.push(pricing.output);
  const srcAmount = candidates.length ? candidates.join(" | ") : null;

  const fallbackCurrency = pricing.currency || null;
  const srcCurrency = detectCurrency(srcAmount, fallbackCurrency) || fallbackCurrency || null;

  let usd = null;
  let note = null;

  // per-character is quoted "$X / 1M characters" — that IS a clean per-1M scalar.
  // We still expose it under media.usd as µUSD-per-1M-characters (single number).
  if (isMissingString(srcAmount)) {
    note = "media rate not stated; scalar left null";
  } else if (isFreeString(srcAmount)) {
    usd = 0;
    note = "free";
  } else {
    const nums = distinctNumbers(srcAmount);
    // For a clean scalar we require EXACTLY ONE numeric magnitude in the string
    // (after stripping the unit). Multiple numbers => ambiguous tiers/options
    // (e.g. Kling "Std $0.084/s; Pro $0.168/s") => DO NOT pick/average -> null.
    if (nums.length === 1) {
      const amt = nums[0];
      if (scheme === "per-character" && /1\s*m|million|百万/i.test(srcAmount)) {
        // per-1M-characters: store the per-1M µUSD figure verbatim.
        usd = toUuusd(amt, srcCurrency || "USD");
        note = "per-1M-characters rate";
      } else {
        usd = toUuusd(amt, srcCurrency || "USD");
      }
    } else if (nums.length === 0) {
      note = "no numeric rate found in media string; scalar left null";
    } else {
      note = `media string carries ${nums.length} distinct rates (tiers/options) — not a single scalar; left null (never averaged)`;
    }
  }

  return {
    media: { unit, srcAmount, srcCurrency, usd },
    note,
  };
}

// ---------------------------------------------------------------------------
// MATRIX parsing (paramMatrix[] of {params, price}). Each row may be a clean
// scalar; the overall model has no single price. We normalize each row's price
// to µUSD where a single number parses, else null + note.
function parseMatrix(pricing) {
  const rows = Array.isArray(pricing.paramMatrix) ? pricing.paramMatrix : [];
  const fallbackCurrency = pricing.currency || null;
  const out = rows.map((r) => {
    const priceStr = typeof r.price === "string" ? r.price : null;
    const cur = detectCurrency(priceStr, fallbackCurrency) || fallbackCurrency || null;
    let usd = null;
    let note = null;
    if (isMissingString(priceStr)) {
      note = "row price not stated";
    } else if (isFreeString(priceStr)) {
      usd = 0;
    } else {
      const nums = distinctNumbers(priceStr);
      if (nums.length === 1) {
        usd = toUuusd(nums[0], cur || "USD");
      } else if (nums.length === 0) {
        note = "no numeric rate in row";
      } else {
        // common shape: "24 credits ($0.12); off-peak 12 credits" -> prefer the
        // explicit $-denominated number if exactly one $-number exists.
        const dollarNums = (priceStr.match(/\$\s*[0-9][0-9,]*(?:\.[0-9]+)?/g) || []).map((x) =>
          Number(x.replace(/[^0-9.]/g, "")),
        );
        if (dollarNums.length === 1) {
          usd = toUuusd(dollarNums[0], "USD");
          note = "row had multiple figures; used the single $-denominated rate";
        } else {
          note = `row carries ${nums.length} figures — ambiguous; scalar left null`;
        }
      }
    }
    return { params: r.params ?? null, srcPrice: priceStr, srcCurrency: cur, usd, note };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Build the normalized pricing block for one model.
function normalizePricing(model, vendor) {
  const p = model.pricing || {};
  const scheme = p.scheme || "unknown";
  const normalizeNotes = [];

  const block = {
    scheme,
    srcCurrency: p.currency || null,
    srcInput: typeof p.input === "string" ? p.input : null,
    srcOutput: typeof p.output === "string" ? p.output : null,
    srcCached: typeof p.cachedInput === "string" ? p.cachedInput : null,
    inputPer1mUsd: null,
    outputPer1mUsd: null,
    cachedInputPer1mUsd: null,
    media: null,
    asOf: p.asOf || null,
    source: p.source || null,
    notes: p.notes || null,
  };

  let complex = false;

  if (TOKEN_SCHEMES.has(scheme)) {
    const fc = p.currency || null;
    const inP = parseTokenPrice(p.input, fc);
    const outP = parseTokenPrice(p.output, fc);
    const cachP = parseTokenPrice(p.cachedInput, fc);

    block.inputPer1mUsd = inP.uusdPer1m;
    block.outputPer1mUsd = outP.uusdPer1m;
    block.cachedInputPer1mUsd = cachP.uusdPer1m;

    if (inP.note) normalizeNotes.push(`input: ${inP.note}`);
    if (outP.note) normalizeNotes.push(`output: ${outP.note}`);
    if (cachP.note && p.cachedInput != null) normalizeNotes.push(`cachedInput: ${cachP.note}`);

    // tiered-tokens: record that tiers exist but base scalar comes from input/output.
    if (scheme === "tiered-tokens" && Array.isArray(p.tiers)) {
      normalizeNotes.push(`tiered-tokens: ${p.tiers.length} tier rows present in source; base inputPer1mUsd/outputPer1mUsd reflect the standard tier only`);
    }
  } else if (["per-image", "per-second", "per-minute", "per-character", "per-request"].includes(scheme)) {
    const { media, note } = parseMediaPrice(scheme, p);
    block.media = media;
    if (note) normalizeNotes.push(`media: ${note}`);
    if (media.usd == null) complex = true; // needs review (no single scalar)
  } else if (scheme === "matrix" || scheme === "per-image-matrix") {
    block.media = { unit: "matrix", rows: parseMatrix(p), srcAmount: block.srcInput, srcCurrency: block.srcCurrency, usd: null };
    normalizeNotes.push("matrix pricing: per-row µUSD where a single rate parses; no single model-level scalar");
    complex = true;
  } else if (scheme === "credits") {
    // credits / formula -> verbatim only, complex:true, null scalar. Never fabricate.
    const rows = Array.isArray(p.paramMatrix) ? parseMatrix(p) : null;
    block.media = { unit: "credits", rows, srcAmount: block.srcInput, srcCurrency: block.srcCurrency, usd: null, complex: true };
    normalizeNotes.push("credit-based pricing: kept verbatim; no single scalar fabricated (rows parsed to µUSD only where a clean $-figure is present)");
    complex = true;
  } else if (scheme === "other") {
    block.media = { unit: "other", srcAmount: block.srcInput, srcCurrency: block.srcCurrency, usd: null, complex: true };
    normalizeNotes.push("'other' pricing scheme (subscription/packs/formula): kept verbatim; no scalar derived");
    complex = true;
  } else {
    normalizeNotes.push(`unrecognized pricing scheme '${scheme}'; left unparsed`);
    complex = true;
  }

  // Paparam matrix attached to a token/media scheme too (e.g. per-image with matrix)
  if (block.media == null && Array.isArray(p.paramMatrix) && p.paramMatrix.length) {
    // attach the per-image/per-second matrix rows alongside the scalar for richness
    block.media = block.media || {};
  }

  return { block, complex, normalizeNotes };
}

// ---------------------------------------------------------------------------
// Confidence assignment (conservative; downgrade when unsure).
function assignConfidence({ vendor, vendorGlobalRecon, model, block, parseClean }) {
  const p = model.pricing || {};
  const reconText = [
    p.notes || "",
    typeof p.input === "string" ? p.input : "",
    typeof p.output === "string" ? p.output : "",
  ].join(" ");

  // 1) reconstructed: Kling (vendor-global), OR this model's own notes/strings
  //    mention reconstructed / 446 / aggregator / reseller.
  if (vendorGlobalRecon || RECON_RE.test(reconText)) {
    return "reconstructed";
  }

  // 2) firstparty: firstparty vendor AND price source on official domain AND
  //    a token scheme that parsed cleanly (both input & output non-null).
  if (
    FIRSTPARTY_VENDORS.has(vendor) &&
    onOfficialDomain(block.source, vendor) &&
    parseClean
  ) {
    return "firstparty";
  }

  // 3) secondary: everything else.
  return "secondary";
}

// ---------------------------------------------------------------------------
// MAIN

function main() {
  const raw = JSON.parse(readFileSync(SRC, "utf8"));

  const models = [];
  const counts = {
    total: 0,
    byConfidence: { firstparty: 0, secondary: 0, reconstructed: 0 },
    billingEligible: 0,
    byType: {},
    byScheme: {},
    unparseableOrComplex: 0,
  };

  for (const v of raw.vendors || []) {
    const vendorNameFull = v.vendor;
    const vendor = vendorKey(vendorNameFull);

    // vendor-global reconstruction: Kling (explicit) OR coverageNotes carry the
    // STRONG signal (reconstructed AND a 446 / "no price ... verbatim" caveat).
    const cn = v.coverageNotes || "";
    const vendorGlobalRecon =
      vendor === "Kling" ||
      (/reconstruct/i.test(cn) && /(446|no price below was read verbatim|not.*verbatim off a first-party)/i.test(cn));

    for (const m of v.models || []) {
      const { block, complex, normalizeNotes } = normalizePricing(m, vendorNameFull);

      // clean token parse = both input & output per-1M present (non-null).
      const parseClean =
        TOKEN_SCHEMES.has(block.scheme) &&
        block.inputPer1mUsd != null &&
        block.outputPer1mUsd != null;

      const confidence = assignConfidence({
        vendor,
        vendorGlobalRecon,
        model: m,
        block,
        parseClean,
      });

      const billingEligible =
        confidence === "firstparty" &&
        TOKEN_SCHEMES.has(block.scheme) &&
        block.inputPer1mUsd != null &&
        block.outputPer1mUsd != null;

      const normModel = {
        vendor: vendorNameFull,
        modelId: m.id,
        displayName: m.displayName,
        type: m.type,
        inputModalities: m.inputModalities || [],
        outputModalities: m.outputModalities || [],
        status: m.status || null,
        contextWindow: m.contextWindow ?? null,
        maxOutput: m.maxOutput ?? null,
        mediaOptions: m.mediaOptions ?? null,
        keyParams: m.keyParams || [],
        intro: m.intro ?? null,
        sources: m.sources || (m.source ? [m.source] : []),
        confidence,
        billingEligible,
        pricing: block,
        normalizeNotes,
      };

      models.push(normModel);

      // counts
      counts.total++;
      counts.byConfidence[confidence] = (counts.byConfidence[confidence] || 0) + 1;
      if (billingEligible) counts.billingEligible++;
      counts.byType[m.type] = (counts.byType[m.type] || 0) + 1;
      counts.byScheme[block.scheme] = (counts.byScheme[block.scheme] || 0) + 1;
      if (complex || (TOKEN_SCHEMES.has(block.scheme) && !parseClean)) counts.unparseableOrComplex++;
    }
  }

  const output = {
    asOf: raw.asOf || "2026-06",
    fx: { CNY_PER_USD },
    generatedNote:
      "Normalized from docs/research/official-model-catalog-2026.json by tools/normalize-catalog.mjs. " +
      "Money unit = µUSD (1 USD = 1,000,000 µUSD). CNY converted at the fixed documented rate CNY_PER_USD=" +
      CNY_PER_USD +
      " (normalization-time assumption, not a live FX feed). " +
      "Prices are parsed faithfully: unparseable / multi-rate / credit / formula prices keep the verbatim source with a null scalar (never invented or averaged). " +
      "confidence ∈ {firstparty, secondary, reconstructed}; billingEligible requires firstparty + token scheme + both input & output per-1M present.",
    counts,
    models,
  };

  // Deterministic JSON (stable key order from object literal construction).
  writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n", "utf8");

  // -------------------------------------------------------------------------
  // SUMMARY
  const line = (s) => process.stdout.write(s + "\n");
  line("=".repeat(70));
  line("NORMALIZE-CATALOG SUMMARY");
  line("=".repeat(70));
  line(`source : ${SRC}`);
  line(`output : ${OUT}`);
  line(`fx     : 1 USD = ${CNY_PER_USD} CNY  |  money unit = µUSD (1 USD = 1,000,000 µUSD)`);
  line("");
  line(`TOTAL models                : ${counts.total}`);
  line("");
  line("BY CONFIDENCE:");
  for (const k of ["firstparty", "secondary", "reconstructed"]) {
    line(`  ${k.padEnd(14)}: ${counts.byConfidence[k] || 0}`);
  }
  line("");
  line(`billingEligible             : ${counts.billingEligible}`);
  line(`unparseable/complex pricing : ${counts.unparseableOrComplex}`);
  line("");
  line("BY TYPE:");
  for (const t of Object.keys(counts.byType).sort()) {
    line(`  ${String(t).padEnd(14)}: ${counts.byType[t]}`);
  }
  line("");
  line("BY SCHEME:");
  for (const s of Object.keys(counts.byScheme).sort()) {
    line(`  ${String(s).padEnd(16)}: ${counts.byScheme[s]}`);
  }
  line("");
  line("SPOT-CHECKS:");
  const find = (vendorMatch, id) =>
    models.find((m) => m.vendor.includes(vendorMatch) && m.modelId === id);
  const spot = (label, m, field) => {
    if (!m) return line(`  [missing] ${label}`);
    line(`  ${label}: ${field(m)}`);
  };
  spot("OpenAI gpt-5.5", find("OpenAI", "gpt-5.5"), (m) =>
    `srcInput=${JSON.stringify(m.pricing.srcInput)} -> inputPer1mUsd=${m.pricing.inputPer1mUsd} (conf=${m.confidence}, billable=${m.billingEligible})`,
  );
  spot("Anthropic claude-sonnet-4-5", find("Anthropic", "claude-sonnet-4-5-20250929"), (m) =>
    `srcInput=${JSON.stringify(m.pricing.srcInput)} -> inputPer1mUsd=${m.pricing.inputPer1mUsd}, outputPer1mUsd=${m.pricing.outputPer1mUsd} (conf=${m.confidence}, billable=${m.billingEligible})`,
  );
  spot("Google gemini-3-pro-image", find("Google", "gemini-3-pro-image"), (m) =>
    `scheme=${m.pricing.scheme}, media.unit=${m.pricing.media && m.pricing.media.unit}, media.usd=${m.pricing.media && m.pricing.media.usd} (conf=${m.confidence}, billable=${m.billingEligible})`,
  );
  const klingAny = models.find((m) => m.vendor.includes("Kling"));
  spot("Kling (first model)", klingAny, (m) =>
    `modelId=${m.modelId} conf=${m.confidence}, billable=${m.billingEligible}`,
  );
  spot("Volcengine doubao CNY token", find("Volcengine", "doubao-seed-2-1-pro-260628") || find("火山", "doubao-seed-2-1-pro-260628"), (m) =>
    `srcInput=${JSON.stringify(m.pricing.srcInput)} (srcCurrency=${m.pricing.srcCurrency}) -> inputPer1mUsd=${m.pricing.inputPer1mUsd} (conf=${m.confidence}, billable=${m.billingEligible})`,
  );
  line("=".repeat(70));
}

main();

import type {
  CreditsSpec,
  FixedSpec,
  FormulaSpec,
  MatrixSpec,
  ModelTokenSpec,
  UnitSpec,
} from '@actionow/contracts';

import { type MicroCredits, PER_1M_TOKENS, roundHalfUpDiv } from '../credits.js';
import { DomainError } from '../errors.js';

/** Basis-points denominator: `10000 bps = 1.0×` (spec D3; integer ratios only). */
const BPS_PER_UNIT = 10_000n;

/** Sum of `usage[dim] * rate` over every priced dimension. Missing usage = 0. */
export function priceUnit(spec: UnitSpec, usage: Record<string, number>): MicroCredits {
  let total = 0n;
  for (const [dim, { rate }] of Object.entries(spec.dimensions)) {
    total += BigInt(usage[dim] ?? 0) * BigInt(rate);
  }
  return total;
}

/**
 * Is `v` truthy as a billing flag? Mirrors a permissive "is this on?" check
 * without the JS coercion footguns: a non-zero finite number, the boolean
 * `true`, or a non-empty string that is NOT `"0"`/`"false"` (case-insensitive,
 * trimmed). Everything else — absent, `0`, `false`, `""`, `"0"`, `"false"`,
 * `null`/`undefined`, objects — is falsy. Explicit so an add-on is charged only
 * on a real signal, never on a stray `"false"` string the adapter forwarded.
 */
function isFlagTruthy(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false';
  }
  return false;
}

/**
 * Credit-billed cost in µUSD (Vidu/Kling): credits = baseCredits + Σ dimensions[d].credits×v[d]
 * + Σ addOns where v[flag] is truthy; cost = credits × creditValueMicroUsd. All-integer bigint.
 * Reads the same snake_case usage/param vector as `priceUnit` (missing = 0/false).
 */
export function priceCredits(spec: CreditsSpec, v: Record<string, unknown>): MicroCredits {
  let credits = BigInt(spec.baseCredits);
  for (const [dim, { credits: perUnit }] of Object.entries(spec.dimensions)) {
    // Coerce the (possibly string/float) usage count to a non-negative integer
    // count: `trunc` keeps the integer-only money invariant (a fractional or
    // non-numeric dimension never throws a BigInt RangeError), clamped at 0 so a
    // negative count can't credit the caller.
    const raw = Math.trunc(Number(v[dim] ?? 0));
    const count = Number.isFinite(raw) && raw > 0 ? raw : 0;
    credits += BigInt(count) * BigInt(perUnit);
  }
  for (const { flag, credits: bonus } of spec.addOns ?? []) {
    if (isFlagTruthy(v[flag])) credits += BigInt(bonus);
  }
  return credits * BigInt(spec.creditValueMicroUsd);
}

/**
 * Look up the µcredit cell for the composite key built from `spec.key`, then
 * multiply by `multiplier`/`perItem` params (each defaulting to 1). A missing
 * cell throws `DomainError('price_key_not_found')`.
 */
export function priceMatrix(spec: MatrixSpec, params: Record<string, unknown>): MicroCredits {
  const key = spec.key.map((k) => String(params[k])).join('|');
  const cell = spec.table[key];
  if (cell === undefined) throw new DomainError('price_key_not_found', `no price for key "${key}"`);
  let result = BigInt(cell);
  if (spec.multiplier !== undefined) result *= BigInt(Number(params[spec.multiplier] ?? 1));
  if (spec.perItem !== undefined) result *= BigInt(Number(params[spec.perItem] ?? 1));
  return result;
}

/** Fixed amount, verbatim. */
export function priceFixed(spec: FixedSpec): MicroCredits {
  return BigInt(spec.amount);
}

const OP_PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2 };

function precedenceOf(op: string | undefined): number {
  if (op === undefined) return 0;
  return OP_PRECEDENCE[op] ?? 0;
}

/**
 * Restricted integer expression evaluator for `formula` pricing.
 *
 * Supports only `+ - * ( )`, non-negative integer literals, and named
 * non-negative integer variables. There is no division, no floats, and no JS
 * `eval` — the expression is tokenised, reconciled against its source (so any
 * stray character such as `/`, `%`, `.` or `require(...)` fails), then run
 * through a shunting-yard evaluator in `bigint`. Any malformed input throws
 * `DomainError('invalid_pricing')`.
 */
export function priceFormula(spec: FormulaSpec, vars: Record<string, number>): MicroCredits {
  const tokens = spec.expr.match(/\d+|[A-Za-z_]\w*|[()+\-*]/g);
  // When the match is null, `?.join` yields undefined which fails the equality
  // check below — so an unmatchable expression still throws.
  if (tokens?.join('') !== spec.expr.replace(/\s+/g, '')) {
    throw new DomainError('invalid_pricing', `illegal formula: ${spec.expr}`);
  }

  const output: bigint[] = [];
  const ops: string[] = [];

  const apply = (op: string): void => {
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) {
      throw new DomainError('invalid_pricing', 'malformed formula');
    }
    output.push(op === '+' ? a + b : op === '-' ? a - b : a * b);
  };

  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      output.push(BigInt(t));
    } else if (/^[A-Za-z_]\w*$/.test(t)) {
      const v = vars[t];
      if (v === undefined || !Number.isInteger(v) || v < 0) {
        throw new DomainError('invalid_pricing', `bad var ${t}`);
      }
      output.push(BigInt(v));
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      let top = ops.pop();
      while (top !== undefined && top !== '(') {
        apply(top);
        top = ops.pop();
      }
      if (top !== '(') throw new DomainError('invalid_pricing', 'unbalanced parens');
    } else {
      let top = ops[ops.length - 1];
      while (top !== undefined && top !== '(' && precedenceOf(top) >= precedenceOf(t)) {
        ops.pop();
        apply(top);
        top = ops[ops.length - 1];
      }
      ops.push(t);
    }
  }

  let op = ops.pop();
  while (op !== undefined) {
    if (op === '(') throw new DomainError('invalid_pricing', 'unbalanced parens');
    apply(op);
    op = ops.pop();
  }

  const result = output.pop();
  if (result === undefined || output.length > 0) {
    throw new DomainError('invalid_pricing', 'malformed formula');
  }
  return result;
}

/**
 * Token-priced cost in µUSD (Track 1 — µUSD per 1M tokens; Track 5 — `group_ratio`).
 * `inputPrice`/`outputPrice` are **µUSD per 1,000,000 tokens** (official `$X/1M`
 * → `X×1e6`); `groupRatioBps` is the per-group customer-price ratio in basis
 * points (`10000 = 1.0×`; omitted → 10000), folded into ONE round-half-up:
 *   `roundHalfUp((in*inputPrice + out*outputPrice) × bps / (1_000_000 × 10000))`.
 * The ratio multiplies the un-divided token×rate product, so the per-1M divide
 * and the ratio share a SINGLE rounding (no intermediate round) — at the default
 * 10000 bps this is exactly the Track-1 result `roundHalfUp(product / 1e6)` (the
 * regression invariant). The ratio is the OPERATOR TIER markup applied to the
 * base BEFORE the entry markup + modifier stack (which `quote`/`settle` and
 * `computeFinalCost` apply downstream).
 *
 * Reads the snake_case `usage.input_tokens`/`usage.output_tokens` keys every
 * adapter emits on its `UsageVector` (missing = 0), serving both `settle`
 * (observed usage) and `quote`/hold (estimated usage) — so the hold sees the
 * SAME ratio as the settle and stays ≥ it. All-integer bigint math.
 *
 * 用拆分计费: when `spec.cachedInputPrice` is set AND the usage carries
 * `cached_input_tokens` (captured by #70), the cached portion of input is billed
 * at the cheaper cached rate. `cached = clamp(cached_input_tokens, 0, input_tokens)`
 * (a provider can never report more cached than total input), so
 *   `input_cost = (input − cached)×inputPrice + cached×cachedInputPrice`.
 * Output (which already includes any `reasoning_tokens` as a SUBSET) is billed
 * once at `outputPrice` — reasoning is NOT added again. When `cachedInputPrice`
 * is undefined OR there are no cached tokens, this reduces to the original
 * `input×inputPrice` (the regression invariant). The cached/non-cached split is
 * folded into the SAME product → the single round-half-up + `groupRatioBps`
 * semantics are unchanged.
 */
export function priceModelToken(spec: ModelTokenSpec, usage: Record<string, number>): MicroCredits {
  const inputTokens = BigInt(usage.input_tokens ?? 0);
  // Clamp cached to [0, inputTokens]: cached is a subset of input, and a bad
  // upstream report (negative / over-total) must never push the charge below the
  // all-input baseline or below zero.
  const rawCached = BigInt(usage.cached_input_tokens ?? 0);
  const cached =
    spec.cachedInputPrice === undefined
      ? 0n
      : rawCached < 0n
        ? 0n
        : rawCached > inputTokens
          ? inputTokens
          : rawCached;
  const cachedRate = BigInt(spec.cachedInputPrice ?? spec.inputPrice);
  const input = (inputTokens - cached) * BigInt(spec.inputPrice) + cached * cachedRate;
  const output = BigInt(usage.output_tokens ?? 0) * BigInt(spec.outputPrice);
  const product = input + output;
  // Default 10000 bps (×1.0) → the Track-1 expression verbatim; any other ratio
  // folds the bps numerator/denominator into the same single round-half-up.
  if (spec.groupRatioBps === undefined || spec.groupRatioBps === 10_000) {
    return roundHalfUpDiv(product, PER_1M_TOKENS);
  }
  return roundHalfUpDiv(product * BigInt(spec.groupRatioBps), PER_1M_TOKENS * BPS_PER_UNIT);
}

/**
 * The SERVED upstream channel's ACTUAL cost for a call in µUSD (Track 5):
 *   `roundHalfUp((in × inputCostPer1m + out × outputCostPer1m) / 1_000_000)`.
 * `inputCostPer1m`/`outputCostPer1m` are the channel's operator-cost rates in
 * µUSD per 1M tokens; a `null` rate is treated as 0 (unknown cost / subscription
 * channel ≈ free). Same per-1M round-half-up as the customer `model_token` base,
 * but this is the OPERATOR cost basis — it drives `usage_log.provider_cost` +
 * margin analytics ONLY and NEVER the customer charge. Reads the snake_case
 * `usage.input_tokens`/`usage.output_tokens` (missing = 0).
 */
export function priceProviderCost(
  usage: Record<string, number>,
  inputCostPer1m: bigint | null | undefined,
  outputCostPer1m: bigint | null | undefined,
): MicroCredits {
  const input = BigInt(usage.input_tokens ?? 0) * (inputCostPer1m ?? 0n);
  const output = BigInt(usage.output_tokens ?? 0) * (outputCostPer1m ?? 0n);
  return roundHalfUpDiv(input + output, PER_1M_TOKENS);
}

import type { PricebookEntry } from '@actionow/contracts';

import type { MicroCredits } from '../credits.js';
import { DomainError } from '../errors.js';
import { applyMarkup } from './markup.js';
import {
  priceCredits,
  priceFixed,
  priceFormula,
  priceMatrix,
  priceModelToken,
  priceUnit,
} from './methods.js';

/**
 * Pre-execution quote: resolve the base µcredit price for a `pre` method
 * (fixed/matrix/formula) from request params, then apply the entry markup.
 * `credits` is quotable pre as well (its inputs can come from request params),
 * mirroring the `unit`-shaped vector. Throws `DomainError('invalid_pricing')`
 * for a usage-dependent (post) method.
 */
export function quote(entry: PricebookEntry, params: Record<string, unknown>): MicroCredits {
  const spec = entry.spec;
  let base: MicroCredits;
  switch (spec.method) {
    case 'fixed':
      base = priceFixed(spec);
      break;
    case 'matrix':
      base = priceMatrix(spec, params);
      break;
    case 'formula':
      base = priceFormula(spec, params as Record<string, number>);
      break;
    case 'model_token':
      base = priceModelToken(spec, params as Record<string, number>);
      break;
    case 'credits':
      base = priceCredits(spec, params);
      break;
    default:
      throw new DomainError('invalid_pricing', `quote() needs a pre method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}

/**
 * Post-execution settle: compute the final µcredit price from observed usage.
 * `unit` prices each dimension; `credits` converts metered credits → µUSD (Vidu/
 * Kling); `passthrough` marks up the caller-supplied `usage.subtotal` (the summed
 * child cost) by the spec markup, then the entry markup. Throws
 * `DomainError('invalid_pricing')` for a pre-only method.
 */
export function settle(entry: PricebookEntry, usage: Record<string, number>): MicroCredits {
  const spec = entry.spec;
  let base: MicroCredits;
  if (spec.method === 'unit') {
    base = priceUnit(spec, usage);
  } else if (spec.method === 'model_token') {
    base = priceModelToken(spec, usage);
  } else if (spec.method === 'credits') {
    base = priceCredits(spec, usage);
  } else if (spec.method === 'passthrough') {
    const inner = applyMarkup(BigInt(usage.subtotal ?? 0), spec.markup);
    return applyMarkup(inner, entry.markup);
  } else {
    throw new DomainError('invalid_pricing', `settle() needs a post method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}

/**
 * The minimum meaningful hold for a `post`-timed dimensioned entry: the
 * markup-adjusted price of exactly ONE of each priced dimension (plus
 * `baseCredits` for a `credits` spec, which `settle` adds in automatically).
 *
 * Used as a SERVER-SIDE floor on the credit hold so a caller-supplied
 * `estimated_usage` of `{}` / all-zero can never produce a 0 hold — a 0 hold would
 * let a ~0-balance account start a paid post-timed run and then settle the real
 * (uncapped) cost, draining the operator's upstream budget for free. Covers both
 * `unit` (per-dimension rate) and `credits` (per-dimension credits × credit
 * value + baseCredits) — both read the same `{dim: 1, …}` vector through
 * `settle`. Returns `undefined` when no floor applies — any other method, a spec
 * with no priced dimensions (a `credits` spec with `baseCredits=0` too), or an
 * all-free spec — in which case callers leave the computed hold unchanged. The
 * `credits` add-ons are intentionally NOT part of the floor (they are conditional
 * flags, not a "one of each dimension" baseline).
 */
export function minimumHold(entry: PricebookEntry): MicroCredits | undefined {
  const spec = entry.spec;
  if (spec.method !== 'unit' && spec.method !== 'credits') return undefined;
  const dims = Object.keys(spec.dimensions);
  // A `credits` spec with no dimensions can still floor on its flat baseCredits;
  // a `unit` spec has no flat term, so an empty-dimension unit spec has no floor.
  if (dims.length === 0 && spec.method === 'unit') return undefined;
  const oneOfEach: Record<string, number> = {};
  for (const dim of dims) oneOfEach[dim] = 1;
  const floor = settle(entry, oneOfEach);
  return floor > 0n ? floor : undefined;
}

import type { PricebookEntry } from '@actionow/contracts';

import type { MicroCredits } from '../credits.js';
import { DomainError } from '../errors.js';
import { applyMarkup } from './markup.js';
import { priceFixed, priceFormula, priceMatrix, priceModelToken, priceUnit } from './methods.js';

/**
 * Pre-execution quote: resolve the base µcredit price for a `pre` method
 * (fixed/matrix/formula) from request params, then apply the entry markup.
 * Throws `DomainError('invalid_pricing')` for a usage-dependent (post) method.
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
    default:
      throw new DomainError('invalid_pricing', `quote() needs a pre method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}

/**
 * Post-execution settle: compute the final µcredit price from observed usage.
 * `unit` prices each dimension; `passthrough` marks up the caller-supplied
 * `usage.subtotal` (the summed child cost) by the spec markup, then the entry
 * markup. Throws `DomainError('invalid_pricing')` for a pre-only method.
 */
export function settle(entry: PricebookEntry, usage: Record<string, number>): MicroCredits {
  const spec = entry.spec;
  let base: MicroCredits;
  if (spec.method === 'unit') {
    base = priceUnit(spec, usage);
  } else if (spec.method === 'model_token') {
    base = priceModelToken(spec, usage);
  } else if (spec.method === 'passthrough') {
    const inner = applyMarkup(BigInt(usage.subtotal ?? 0), spec.markup);
    return applyMarkup(inner, entry.markup);
  } else {
    throw new DomainError('invalid_pricing', `settle() needs a post method, got ${spec.method}`);
  }
  return applyMarkup(base, entry.markup);
}

/**
 * The minimum meaningful hold for a `post`-timed `unit` entry: the markup-adjusted
 * price of exactly ONE of each priced dimension.
 *
 * Used as a SERVER-SIDE floor on the credit hold so a caller-supplied
 * `estimated_usage` of `{}` / all-zero can never produce a 0 hold — a 0 hold would
 * let a ~0-balance account start a paid post-timed run and then settle the real
 * (uncapped) cost, draining the operator's upstream budget for free. Returns
 * `undefined` when no floor applies — a non-`unit` method, a unit spec with no
 * dimensions, or an all-free spec (every rate 0) — in which case callers leave the
 * computed hold unchanged.
 */
export function minimumHold(entry: PricebookEntry): MicroCredits | undefined {
  const spec = entry.spec;
  if (spec.method !== 'unit') return undefined;
  const dims = Object.keys(spec.dimensions);
  if (dims.length === 0) return undefined;
  const oneOfEach: Record<string, number> = {};
  for (const dim of dims) oneOfEach[dim] = 1;
  const floor = settle(entry, oneOfEach);
  return floor > 0n ? floor : undefined;
}

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

import type { PricebookMethod } from '../../lib/api/types';

/**
 * Editable form state for the pricebook `spec` builder — a superset holding the
 * fields for every method; `buildSpec(method, state)` projects out just the
 * branch the chosen `method` needs. All rate/cell numbers are µcredits
 * (1 credit = 1,000,000 µcredits); the human-credit `fixedCredits` lives on the
 * pricing modal (Page 1b), not here.
 */
export interface SpecFormState {
  /** unit: named dimensions → per-unit rate (µcredits). */
  dimensions: { name: string; rate: number }[];
  /** formula: a single expression over request-param variable names. */
  expr: string;
  /** matrix: the dimension names that compose the joined table key. */
  key: string[];
  /** matrix: joined-key → µcredits cell. */
  table: { k: string; cell: number }[];
  /** matrix (optional): variable name to multiply by. */
  multiplier: string;
  /** matrix (optional): variable name charged per item. */
  perItem: string;
  /** passthrough: an optional markup over the upstream cost. */
  markup: { enabled: boolean; type: 'percent' | 'flat'; value: number };
}

export function emptySpecForm(): SpecFormState {
  return {
    dimensions: [{ name: '', rate: 0 }],
    expr: '',
    key: [],
    table: [],
    multiplier: '',
    perItem: '',
    markup: { enabled: false, type: 'percent', value: 0 },
  };
}

/** A formula may use only identifiers, ints, spaces and `+ - * ( )` — no `/ % .`. */
export function validateFormula(expr: string): boolean {
  return expr.trim() !== '' && /^[\sA-Za-z0-9_+\-*()]+$/.test(expr) && !/[/%.]/.test(expr);
}

export function buildSpec(method: PricebookMethod, s: SpecFormState): Record<string, unknown> {
  switch (method) {
    case 'unit': {
      const dimensions: Record<string, { rate: number }> = {};
      for (const d of s.dimensions)
        if (d.name.trim() !== '') dimensions[d.name.trim()] = { rate: d.rate };
      return { method: 'unit', dimensions };
    }
    case 'matrix': {
      const table: Record<string, number> = {};
      for (const row of s.table) if (row.k.trim() !== '') table[row.k.trim()] = row.cell;
      const out: Record<string, unknown> = { method: 'matrix', key: s.key, table };
      if (s.multiplier.trim() !== '') out.multiplier = s.multiplier.trim();
      if (s.perItem.trim() !== '') out.perItem = s.perItem.trim();
      return out;
    }
    case 'formula':
      return { method: 'formula', expr: s.expr.trim() };
    case 'passthrough':
      return s.markup.enabled
        ? { method: 'passthrough', markup: { type: s.markup.type, value: s.markup.value } }
        : { method: 'passthrough' };
    case 'fixed':
    default:
      return { method }; // fixed amount comes from fixedCredits
  }
}

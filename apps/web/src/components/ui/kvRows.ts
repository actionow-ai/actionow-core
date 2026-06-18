import { rowId } from '../../lib/rowId';

/**
 * Pure row⇄object conversion for `KeyValueEditor`. A `KvRow` is one editable
 * key/value pair; the editor holds an ordered list of them and converts to/from
 * the `Record<string,string>` the backend expects (e.g. channel `config`).
 *
 * Each row carries a stable `id` (minted at creation) used purely as the React
 * key so removing a middle row doesn't strand the surviving rows' focus. The id
 * never reaches the backend — `objectFromRows` projects out only key/value.
 */
export interface KvRow {
  id: string;
  key: string;
  value: string;
}

/** A fresh blank row with a unique id (for the initial/added empty row). */
export function blankRow(): KvRow {
  return { id: rowId(), key: '', value: '' };
}

/**
 * Seed editable rows from an object. An empty/missing object yields a single
 * blank row so there is always something to type into. Non-string values are
 * JSON-stringified so they remain editable as text.
 */
export function rowsFromObject(obj: Record<string, unknown> | null | undefined): KvRow[] {
  const entries = Object.entries(obj ?? {});
  if (entries.length === 0) return [blankRow()];
  return entries.map(([key, value]) => ({
    id: rowId(),
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

/** Collapse rows to an object: blank keys are dropped; on duplicate keys, last wins. */
export function objectFromRows(
  rows: readonly Pick<KvRow, 'key' | 'value'>[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim() !== '') out[r.key.trim()] = r.value;
  return out;
}

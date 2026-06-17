/**
 * Pure row⇄object conversion for `KeyValueEditor`. A `KvRow` is one editable
 * key/value pair; the editor holds an ordered list of them and converts to/from
 * the `Record<string,string>` the backend expects (e.g. channel `config`).
 */
export interface KvRow {
  key: string;
  value: string;
}

/**
 * Seed editable rows from an object. An empty/missing object yields a single
 * blank row so there is always something to type into. Non-string values are
 * JSON-stringified so they remain editable as text.
 */
export function rowsFromObject(obj: Record<string, unknown> | null | undefined): KvRow[] {
  const entries = Object.entries(obj ?? {});
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

/** Collapse rows to an object: blank keys are dropped; on duplicate keys, last wins. */
export function objectFromRows(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim() !== '') out[r.key.trim()] = r.value;
  return out;
}

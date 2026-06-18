/**
 * Mints process-unique ids for editable list rows. Editable add/remove lists of
 * controlled inputs MUST key on a stable per-row id (not the array index):
 * index keys make React reconcile by position, so removing a middle row strands
 * the surviving rows' focus/caret on the wrong element. A monotonic counter is
 * enough — keys only need to be unique among siblings, and stable across the
 * row's lifetime (mint once at creation, never re-derive from content).
 */
let seq = 0;

export function rowId(): string {
  seq += 1;
  return `row-${String(seq)}`;
}

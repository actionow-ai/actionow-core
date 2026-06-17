/**
 * Pure, framework-free table logic for `DataTable`. Kept separate so the
 * correctness-critical bits (filter / sort / paginate / selection) are unit
 * tested in isolation; the component just composes these with `useState`.
 */

export type SortDirection = 'asc' | 'desc' | 'none';

/** Cycle a sortable header: asc → desc → none → asc. */
export function nextSortDirection(current: SortDirection): SortDirection {
  if (current === 'none') return 'asc';
  if (current === 'asc') return 'desc';
  return 'none';
}

/**
 * Case-insensitive substring filter over a projected text per row. A blank /
 * whitespace-only query matches everything (no narrowing).
 */
export function filterRows<T>(rows: T[], query: string, text: (row: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter((r) => text(r).toLowerCase().includes(needle));
}

/**
 * Stable, non-mutating sort by a comparable value. Numbers compare
 * numerically; everything else compares as a locale-aware, case-insensitive
 * string. `'none'` returns the input order unchanged.
 */
export function sortRows<T>(
  rows: T[],
  value: (row: T) => string | number,
  direction: SortDirection,
): T[] {
  if (direction === 'none') return rows;
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
    return (
      String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) *
      factor
    );
  });
}

/** Number of pages for `total` rows at `pageSize` (always ≥ 1). */
export function totalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a 1-based page number into the valid `[1, totalPages]` range. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = totalPages(total, pageSize);
  if (page < 1) return 1;
  if (page > pages) return pages;
  return page;
}

/** Slice the rows for a 1-based page, clamping an out-of-range page. */
export function paginate<T>(rows: T[], page: number, pageSize: number): T[] {
  if (pageSize <= 0) return rows;
  const safe = clampPage(page, rows.length, pageSize);
  const start = (safe - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/** Immutably toggle a key in/out of a selection set. */
export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Immutably add every supplied key to the selection. */
export function selectAll(selected: ReadonlySet<string>, keys: string[]): Set<string> {
  const next = new Set(selected);
  for (const k of keys) next.add(k);
  return next;
}

/** Immutably remove every supplied key from the selection. */
export function deselectAll(selected: ReadonlySet<string>, keys: string[]): Set<string> {
  const next = new Set(selected);
  for (const k of keys) next.delete(k);
  return next;
}

/** True only when the page is non-empty and every page key is selected. */
export function isAllSelected(selected: ReadonlySet<string>, keys: string[]): boolean {
  return keys.length > 0 && keys.every((k) => selected.has(k));
}

/** True when some — but not all — page keys are selected. */
export function indeterminate(selected: ReadonlySet<string>, keys: string[]): boolean {
  const some = keys.some((k) => selected.has(k));
  return some && !isAllSelected(selected, keys);
}

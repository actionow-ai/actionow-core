import { describe, expect, it } from 'vitest';

import {
  clampPage,
  filterRows,
  indeterminate,
  isAllSelected,
  paginate,
  selectAll,
  sortRows,
  toggleKey,
  totalPages,
} from './tableState';

interface Row {
  id: string;
  name: string;
  weight: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', weight: 3 },
  { id: 'b', name: 'bravo', weight: 1 },
  { id: 'c', name: 'Charlie', weight: 2 },
  { id: 'd', name: 'delta', weight: 10 },
];

describe('filterRows', () => {
  const text = (r: Row) => `${r.name} ${String(r.weight)}`;

  it('returns all rows for an empty query', () => {
    expect(filterRows(ROWS, '', text)).toHaveLength(4);
    expect(filterRows(ROWS, '   ', text)).toHaveLength(4);
  });

  it('matches case-insensitively', () => {
    expect(filterRows(ROWS, 'ALPHA', text).map((r) => r.id)).toEqual(['a']);
    expect(filterRows(ROWS, 'bravo', text).map((r) => r.id)).toEqual(['b']);
  });

  it('matches a substring anywhere in the projected text', () => {
    // "a" appears in Alpha, bravo, Charlie, delta
    expect(
      filterRows(ROWS, 'a', text)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(filterRows(ROWS, 'har', text).map((r) => r.id)).toEqual(['c']);
  });

  it('matches on the projected field (e.g. numeric weight)', () => {
    expect(filterRows(ROWS, '10', text).map((r) => r.id)).toEqual(['d']);
  });

  it('returns nothing when no row matches', () => {
    expect(filterRows(ROWS, 'zzz', text)).toHaveLength(0);
  });
});

describe('sortRows', () => {
  const value = (r: Row) => r.weight;

  it('returns the input order when direction is none', () => {
    expect(sortRows(ROWS, value, 'none').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts ascending by sortValue', () => {
    expect(sortRows(ROWS, value, 'asc').map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('sorts descending by sortValue', () => {
    expect(sortRows(ROWS, value, 'desc').map((r) => r.id)).toEqual(['d', 'a', 'c', 'b']);
  });

  it('sorts strings case-insensitively and naturally', () => {
    const byName = (r: Row) => r.name;
    expect(sortRows(ROWS, byName, 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRows(ROWS, byName, 'desc').map((r) => r.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const copy = [...ROWS];
    sortRows(ROWS, value, 'asc');
    expect(ROWS).toEqual(copy);
  });
});

describe('totalPages / clampPage', () => {
  it('computes the page count', () => {
    expect(totalPages(0, 10)).toBe(1);
    expect(totalPages(10, 10)).toBe(1);
    expect(totalPages(11, 10)).toBe(2);
    expect(totalPages(25, 10)).toBe(3);
  });

  it('clamps a page into [1, totalPages]', () => {
    expect(clampPage(0, 25, 10)).toBe(1);
    expect(clampPage(99, 25, 10)).toBe(3);
    expect(clampPage(2, 25, 10)).toBe(2);
  });
});

describe('paginate', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: String(i),
    name: `r${String(i)}`,
    weight: i,
  }));

  it('slices the requested page', () => {
    expect(paginate(rows, 1, 10).map((r) => r.id)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(paginate(rows, 2, 10).map((r) => r.id)[0]).toBe('10');
  });

  it('returns the partial last page', () => {
    expect(paginate(rows, 3, 10).map((r) => r.id)).toEqual(['20', '21', '22', '23', '24']);
  });

  it('clamps an out-of-range page to the last page', () => {
    expect(paginate(rows, 99, 10).map((r) => r.id)).toEqual(['20', '21', '22', '23', '24']);
  });
});

describe('selection helpers', () => {
  it('toggles a key in/out of the set', () => {
    const empty = new Set<string>();
    const added = toggleKey(empty, 'a');
    expect(added.has('a')).toBe(true);
    expect(empty.has('a')).toBe(false); // immutable
    const removed = toggleKey(added, 'a');
    expect(removed.has('a')).toBe(false);
  });

  it('selectAll adds every key on the page, preserving existing selection', () => {
    const next = selectAll(new Set(['x']), ['a', 'b']);
    expect([...next].sort()).toEqual(['a', 'b', 'x']);
  });

  it('isAllSelected is true only when every page key is selected', () => {
    expect(isAllSelected(new Set(['a', 'b']), ['a', 'b'])).toBe(true);
    expect(isAllSelected(new Set(['a']), ['a', 'b'])).toBe(false);
    expect(isAllSelected(new Set<string>(), [])).toBe(false); // empty page is not "all selected"
  });

  it('indeterminate is true when some but not all page keys are selected', () => {
    expect(indeterminate(new Set(['a']), ['a', 'b'])).toBe(true);
    expect(indeterminate(new Set(['a', 'b']), ['a', 'b'])).toBe(false);
    expect(indeterminate(new Set<string>(), ['a', 'b'])).toBe(false);
  });
});

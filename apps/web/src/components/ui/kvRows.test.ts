import { describe, expect, it } from 'vitest';

import { blankRow, objectFromRows, rowsFromObject } from './kvRows';

const pairs = (rows: { key: string; value: string }[]) =>
  rows.map((r) => ({ key: r.key, value: r.value }));

describe('kvRows', () => {
  it('rows→object drops blank keys, last-wins on dup', () => {
    expect(
      objectFromRows([
        { key: 'a', value: '1' },
        { key: '', value: 'x' },
        { key: 'a', value: '2' },
      ]),
    ).toEqual({ a: '2' });
  });
  it('object→rows preserves key/value order', () => {
    expect(pairs(rowsFromObject({ a: '1', b: '2' }))).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });
  it('empty object → one blank row for editing', () => {
    expect(pairs(rowsFromObject({}))).toEqual([{ key: '', value: '' }]);
  });
  it('assigns a unique, stable id to every row (React key)', () => {
    const rows = rowsFromObject({ a: '1', b: '2', c: '3' });
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
  it('blankRow mints a fresh id on each call', () => {
    expect(blankRow().id).not.toBe(blankRow().id);
  });
});

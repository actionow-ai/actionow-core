import { describe, expect, it } from 'vitest';

import { objectFromRows, rowsFromObject } from './kvRows';

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
  it('object→rows is stable', () => {
    expect(rowsFromObject({ a: '1', b: '2' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });
  it('empty object → one blank row for editing', () => {
    expect(rowsFromObject({})).toEqual([{ key: '', value: '' }]);
  });
});

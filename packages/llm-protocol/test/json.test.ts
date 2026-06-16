import { describe, expect, it } from 'vitest';

import { asArray, asNumber, asRecord, asString, parseJsonRecord } from '../src/internal/json.js';

describe('json narrowing helpers', () => {
  it('narrows records, arrays, strings, numbers', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();
    expect(asArray([1])).toEqual([1]);
    expect(asString('x')).toBe('x');
    expect(asNumber(3)).toBe(3);
    expect(asNumber(Number.NaN)).toBeUndefined();
  });
  it('parses JSON records, tolerating garbage', () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonRecord('not json')).toBeUndefined();
    expect(parseJsonRecord('[1]')).toBeUndefined();
  });
});

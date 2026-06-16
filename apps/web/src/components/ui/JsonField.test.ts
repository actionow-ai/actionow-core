import { describe, expect, it } from 'vitest';

import { validateJson } from './JsonField';

describe('validateJson', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(validateJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('returns ok with undefined for empty input', () => {
    expect(validateJson('   ')).toEqual({ ok: true, value: undefined });
  });
  it('returns an error for malformed JSON', () => {
    const r = validateJson('{bad}');
    expect(r.ok).toBe(false);
  });
});

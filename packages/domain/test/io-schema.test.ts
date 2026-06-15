import type { IoSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { validateInputs } from '../src/io-schema/index.js';

const schema: IoSchema = {
  inputs: [
    { key: 'prompt', type: 'string', required: true, maxLength: 5 },
    { key: 'tone', type: 'enum', options: ['a', 'b'], default: 'a' },
    { key: 'count', type: 'number', required: false },
  ],
  outputs: [],
};

describe('validateInputs', () => {
  it('accepts valid inputs and fills defaults', () => {
    const r = validateInputs(schema, { prompt: 'hi' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ prompt: 'hi', tone: 'a' });
  });
  it('rejects missing required field', () => {
    const r = validateInputs(schema, { tone: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
  it('rejects maxLength violation', () => {
    expect(validateInputs(schema, { prompt: 'toolong' }).ok).toBe(false);
  });
  it('rejects value not in enum', () => {
    expect(validateInputs(schema, { prompt: 'hi', tone: 'z' }).ok).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(validateInputs(schema, { prompt: 'hi', extra: 1 }).ok).toBe(false);
  });
});

describe('validateInputs — exhaustive types & semantics', () => {
  const typed: IoSchema = {
    inputs: [
      { key: 'flag', type: 'boolean', required: true },
      { key: 'asset', type: 'file' },
      { key: 'gallery', type: 'file_list' },
      { key: 'n', type: 'number' },
    ],
    outputs: [],
  };

  it('accepts boolean / file / file_list types', () => {
    const r = validateInputs(typed, {
      flag: true,
      asset: 'ref://a',
      gallery: ['ref://a', 'ref://b'],
      n: 3,
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        flag: true,
        asset: 'ref://a',
        gallery: ['ref://a', 'ref://b'],
        n: 3,
      });
  });

  it('rejects a non-boolean for a boolean field', () => {
    expect(validateInputs(typed, { flag: 'yes' }).ok).toBe(false);
  });

  it('rejects a file_list containing a non-string', () => {
    expect(validateInputs(typed, { flag: true, gallery: ['ok', 7] }).ok).toBe(false);
  });

  it('rejects a non-number for a number field', () => {
    expect(validateInputs(typed, { flag: true, n: 'three' }).ok).toBe(false);
  });

  it('does not require optional fields (required omitted defaults to false)', () => {
    const optional: IoSchema = {
      inputs: [{ key: 'maybe', type: 'string' }],
      outputs: [],
    };
    const r = validateInputs(optional, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it('does not override an explicitly provided value with the default', () => {
    const r = validateInputs(schema, { prompt: 'hi', tone: 'b' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ prompt: 'hi', tone: 'b' });
  });

  it('surfaces multiple required violations as invalid_input', () => {
    const twoRequired: IoSchema = {
      inputs: [
        { key: 'a', type: 'string', required: true },
        { key: 'b', type: 'number', required: true },
      ],
      outputs: [],
    };
    const r = validateInputs(twoRequired, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.message).toMatch(/a/);
      expect(r.error.message).toMatch(/b/);
    }
  });

  it('treats an enum field with no options as an invalid config (invalid_input)', () => {
    const bad: IoSchema = {
      inputs: [{ key: 'x', type: 'enum' }],
      outputs: [],
    };
    const r = validateInputs(bad, { x: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

import { describe, expect, it } from 'vitest';

import { buildIoSchema, cleanField, emptyIoField } from './ioSchemaShape';

describe('ioSchemaShape', () => {
  it('emptyIoField is a blank string field with a stable id', () => {
    const f = emptyIoField();
    expect(f).toMatchObject({ key: '', type: 'string', required: false });
    expect(typeof f.id).toBe('string');
    expect(f.id?.length ?? 0).toBeGreaterThan(0);
  });

  it('cleanField trims the key, keeps enum options, drops maxLength:0', () => {
    expect(
      cleanField({ key: ' p ', type: 'enum', options: ['a'], required: true, maxLength: 0 }),
    ).toEqual({ key: 'p', type: 'enum', required: true, options: ['a'] });
  });

  it('cleanField drops options for non-enum types', () => {
    expect(cleanField({ key: 'n', type: 'number', options: ['a'], required: false })).toEqual({
      key: 'n',
      type: 'number',
      required: false,
    });
  });

  it('cleanField keeps a positive maxLength only for string/file', () => {
    expect(cleanField({ key: 's', type: 'string', maxLength: 12 })).toEqual({
      key: 's',
      type: 'string',
      required: false,
      maxLength: 12,
    });
    expect(cleanField({ key: 'n', type: 'number', maxLength: 12 })).toEqual({
      key: 'n',
      type: 'number',
      required: false,
    });
  });

  it('cleanField keeps a non-empty label', () => {
    expect(cleanField({ key: 'k', type: 'string', label: ' Prompt ' })).toEqual({
      key: 'k',
      type: 'string',
      required: false,
      label: 'Prompt',
    });
  });

  it('cleanField carries a present default through and leaves an absent one absent', () => {
    expect(cleanField({ key: 'x', type: 'string', default: 'hi' }).default).toBe('hi');
    expect(cleanField({ key: 'x', type: 'string' })).not.toHaveProperty('default');
  });

  it('buildIoSchema filters blank-key rows and cleans the rest', () => {
    expect(
      buildIoSchema(
        [
          { key: 'prompt', type: 'string', required: true },
          { key: '', type: 'string' },
        ],
        [{ key: 'text', type: 'string' }],
      ),
    ).toEqual({
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string', required: false }],
    });
  });
});

// The minimal JSON pointer: dotted keys + array subscripts, missing hops →
// undefined, setPath materializes intermediate containers.
import { describe, expect, it } from 'vitest';

import { getPath, parseJsonPath, setPath } from '../../src/index.js';

describe('parseJsonPath', () => {
  it('parses keys, indices, and the mixed form', () => {
    expect(parseJsonPath('$')).toEqual([]);
    expect(parseJsonPath('$.a.b.c')).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'key', key: 'b' },
      { kind: 'key', key: 'c' },
    ]);
    expect(parseJsonPath('$.items[0].url')).toEqual([
      { kind: 'key', key: 'items' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'url' },
    ]);
  });

  it('rejects malformed paths', () => {
    expect(() => parseJsonPath('a.b')).toThrow(/must start with/);
    expect(() => parseJsonPath('$.')).toThrow(/empty key/);
    expect(() => parseJsonPath('$.a[x]')).toThrow(/non-negative integer/);
    expect(() => parseJsonPath('$.a[0')).toThrow(/unterminated/);
  });
});

describe('getPath', () => {
  const root = {
    usage: { prompt_tokens: 12, completion_tokens: 34 },
    data: [{ id: 'm-a' }, { id: 'm-b' }],
    nested: { list: [{ deep: { value: 7 } }] },
  };

  it('reads dotted keys and array subscripts', () => {
    expect(getPath(root, '$.usage.prompt_tokens')).toBe(12);
    expect(getPath(root, '$.data[1].id')).toBe('m-b');
    expect(getPath(root, '$.nested.list[0].deep.value')).toBe(7);
    expect(getPath(root, '$')).toBe(root);
  });

  it('returns undefined for any missing / mismatched hop (never throws)', () => {
    expect(getPath(root, '$.usage.missing')).toBeUndefined();
    expect(getPath(root, '$.data[9].id')).toBeUndefined();
    expect(getPath(root, '$.usage[0]')).toBeUndefined(); // index into an object
    expect(getPath(root, '$.data.id')).toBeUndefined(); // key into an array
    expect(getPath(undefined, '$.a')).toBeUndefined();
    expect(getPath(null, '$.a')).toBeUndefined();
    expect(getPath('scalar', '$.a')).toBeUndefined();
  });
});

describe('setPath', () => {
  it('writes a shallow key', () => {
    const target: Record<string, unknown> = {};
    setPath(target, '$.model', 'gpt-x');
    expect(target).toEqual({ model: 'gpt-x' });
  });

  it('builds intermediate objects', () => {
    const target: Record<string, unknown> = {};
    setPath(target, '$.input.prompt', 'hello');
    setPath(target, '$.input.opts.temperature', 0.5);
    expect(target).toEqual({ input: { prompt: 'hello', opts: { temperature: 0.5 } } });
  });

  it('builds intermediate arrays for index segments', () => {
    const target: Record<string, unknown> = {};
    setPath(target, '$.messages[0].role', 'user');
    setPath(target, '$.messages[0].content', 'hi');
    expect(target).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  it('overwrites an existing leaf and preserves siblings', () => {
    const target: Record<string, unknown> = { a: { x: 1, y: 2 } };
    setPath(target, '$.a.x', 99);
    expect(target).toEqual({ a: { x: 99, y: 2 } });
  });

  it('refuses to write the root path', () => {
    expect(() => {
      setPath({}, '$', 1);
    }).toThrow(/root json path/);
  });
});

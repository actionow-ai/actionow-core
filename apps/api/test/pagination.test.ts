import { EngineError } from '@actionow/engine';
import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  parsePageQuery,
  toPageEnvelope,
  toPageParams,
} from '../src/common/pagination.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a (createdAt, id) pair through base64url', () => {
    const createdAt = new Date('2026-06-17T12:34:56.789Z');
    const id = 'a1b2c3d4-0000-0000-0000-000000000000';

    const cursor = encodeCursor(createdAt, id);
    const decoded = decodeCursor(cursor);

    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe(id);
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    const cursor = encodeCursor(new Date('2026-01-01T00:00:00.000Z'), 'some-id');
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('round-trips a text PK that contains the delimiter is impossible — id has no pipe, but other chars survive', () => {
    // The tiebreaker is a uuid/slug/code — none contain "|". Verify a slug with
    // hyphens/dots survives the round-trip (the split is on the FIRST pipe).
    const createdAt = new Date('2026-06-17T00:00:00.000Z');
    const id = 'codex.gpt-5-mini';
    const decoded = decodeCursor(encodeCursor(createdAt, id));
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it('throws on a non-base64url string', () => {
    expect(() => decodeCursor('!!!not base64!!!')).toThrow();
  });

  it('throws on a base64url payload missing the delimiter', () => {
    const bad = Buffer.from('no-delimiter-here', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow();
  });

  it('throws on a base64url payload with an invalid date', () => {
    const bad = Buffer.from('not-a-date|some-id', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow();
  });
});

describe('parsePageQuery', () => {
  it('defaults limit to 50 and cursor to undefined when absent', () => {
    expect(parsePageQuery({})).toEqual({ limit: 50 });
  });

  it('clamps limit above 200 down to 200', () => {
    expect(parsePageQuery({ limit: '5000' }).limit).toBe(200);
  });

  it('clamps limit below 1 up to 1', () => {
    expect(parsePageQuery({ limit: '0' }).limit).toBe(1);
    expect(parsePageQuery({ limit: '-9' }).limit).toBe(1);
  });

  it('defaults limit when NaN', () => {
    expect(parsePageQuery({ limit: 'abc' }).limit).toBe(50);
  });

  it('passes the opaque cursor string through unchanged', () => {
    const c = encodeCursor(new Date(), 'x');
    expect(parsePageQuery({ cursor: c }).cursor).toBe(c);
  });
});

describe('toPageParams', () => {
  it('decodes the cursor into a (createdAt, id) PageParams', () => {
    const createdAt = new Date('2026-06-17T12:00:00.000Z');
    const cursor = encodeCursor(createdAt, 'k1');
    const params = toPageParams({ cursor, limit: '10' });
    expect(params.limit).toBe(10);
    expect(params.cursor).toEqual({ createdAt, id: 'k1' });
  });

  it('omits cursor (undefined) when none is supplied', () => {
    const params = toPageParams({});
    expect(params.cursor).toBeUndefined();
    expect(params.limit).toBe(50);
  });

  it('maps a bad cursor to an invalid_input EngineError (400)', () => {
    let thrown: unknown;
    try {
      toPageParams({ cursor: 'garbage!!!' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect((thrown as EngineError).unified.code).toBe('invalid_input');
  });
});

describe('toPageEnvelope', () => {
  const idOf = (r: { id: string }): string => r.id;
  const rows = [
    { id: 'a', createdAt: new Date('2026-06-17T03:00:00.000Z') },
    { id: 'b', createdAt: new Date('2026-06-17T02:00:00.000Z') },
  ];

  it('returns has_more=false and next_cursor=null when hasMore is false', () => {
    const env = toPageEnvelope(rows, false, idOf);
    expect(env.data).toEqual(rows);
    expect(env.has_more).toBe(false);
    expect(env.next_cursor).toBeNull();
  });

  it('returns has_more=true and a next_cursor from the last row when hasMore is true', () => {
    const env = toPageEnvelope(rows, true, idOf);
    expect(env.has_more).toBe(true);
    expect(env.next_cursor).not.toBeNull();
    // next_cursor decodes to the last kept row (the keyset's exclusive bound).
    const cursor = env.next_cursor;
    if (cursor === null) throw new Error('expected a next_cursor');
    const lastRow = rows[1];
    if (lastRow === undefined) throw new Error('fixture has a second row');
    expect(decodeCursor(cursor)).toEqual({ createdAt: lastRow.createdAt, id: 'b' });
  });

  it('returns next_cursor=null on an empty page even if hasMore is somehow true', () => {
    const env = toPageEnvelope<{ id: string; createdAt: Date }>([], true, idOf);
    expect(env.data).toEqual([]);
    expect(env.next_cursor).toBeNull();
    expect(env.has_more).toBe(false);
  });

  it('reads created_at from a createdAt field (the universal keyset column)', () => {
    const env = toPageEnvelope(rows, true, idOf);
    const cursor = env.next_cursor;
    if (cursor === null) throw new Error('expected a next_cursor');
    const decoded = decodeCursor(cursor);
    expect(decoded.createdAt.toISOString()).toBe('2026-06-17T02:00:00.000Z');
  });
});

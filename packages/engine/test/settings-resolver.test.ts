import type { AppEnv } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import { SettingsResolver } from '../src/settings-resolver.js';

/** A minimal env carrying the fields the registry defaults read. */
const ENV = {
  RELAY_TRACE: 'off',
  RELAY_TRACE_MAX_BYTES: 1_000_000,
  RATE_LIMIT_TENANT_PER_MIN: 600,
  RATE_LIMIT_RESOURCE_PER_MIN: 120,
  AUTH_RATE_LIMIT_PER_MIN: undefined,
  STORAGE_MAX_UPLOAD_BYTES: 100,
  ALLOW_DEV_TENANT_HEADER: false,
  CREDIT_RATE: 10_000,
} as unknown as AppEnv;

interface Row {
  key: string;
  value: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

/** A fake `db` whose `select().from()` resolves the closed-over `rows` (or throws). */
function fakeDb(getRows: () => Row[] | Error): never {
  return {
    select: () => ({
      from: () => {
        const r = getRows();
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    }),
  } as never;
}

describe('SettingsResolver', () => {
  it('returns env defaults when there is no override row', async () => {
    const r = new SettingsResolver({ db: fakeDb(() => []), env: ENV });
    expect(await r.get('RELAY_TRACE')).toBe('off');
    const all = await r.getAll();
    expect(all.RELAY_TRACE.source).toBe('env');
    expect(all.AUTH_RATE_LIMIT_PER_MIN.value).toBe(10); // code default (env unset)
  });

  it('applies a valid override (source = db)', async () => {
    const r = new SettingsResolver({
      db: fakeDb(() => [{ key: 'RELAY_TRACE', value: 'full', updatedBy: 'a1', updatedAt: new Date(0) }]),
      env: ENV,
    });
    expect(await r.get('RELAY_TRACE')).toBe('full');
    const all = await r.getAll();
    expect(all.RELAY_TRACE.source).toBe('db');
    expect(all.RELAY_TRACE.updatedBy).toBe('a1');
  });

  it('ignores an override whose value fails the schema (falls back to env)', async () => {
    const r = new SettingsResolver({
      db: fakeDb(() => [{ key: 'RELAY_TRACE', value: 'bogus', updatedBy: null, updatedAt: new Date(0) }]),
      env: ENV,
    });
    expect(await r.get('RELAY_TRACE')).toBe('off');
    expect((await r.getAll()).RELAY_TRACE.source).toBe('env');
  });

  it('caches within the TTL and refreshes after it', async () => {
    let rows: Row[] = [];
    let nowMs = 0;
    const r = new SettingsResolver({
      db: fakeDb(() => rows),
      env: ENV,
      ttlMs: 10_000,
      now: () => nowMs,
    });
    expect(await r.get('RELAY_TRACE')).toBe('off');
    rows = [{ key: 'RELAY_TRACE', value: 'full', updatedBy: null, updatedAt: new Date(0) }];
    nowMs = 5_000; // within TTL → still cached
    expect(await r.get('RELAY_TRACE')).toBe('off');
    nowMs = 11_000; // past TTL → refreshes
    expect(await r.get('RELAY_TRACE')).toBe('full');
  });

  it('fails open to env defaults when the DB read throws', async () => {
    const r = new SettingsResolver({ db: fakeDb(() => new Error('db down')), env: ENV });
    expect(await r.get('RELAY_TRACE')).toBe('off');
    expect(await r.get('STORAGE_MAX_UPLOAD_BYTES')).toBe(100);
  });

  it('invalidate() forces a re-read even within the TTL', async () => {
    let rows: Row[] = [];
    const r = new SettingsResolver({ db: fakeDb(() => rows), env: ENV, now: () => 0 });
    expect(await r.get('RELAY_TRACE')).toBe('off');
    rows = [{ key: 'RELAY_TRACE', value: 'full', updatedBy: null, updatedAt: new Date(0) }];
    expect(await r.get('RELAY_TRACE')).toBe('off'); // still cached (now frozen at 0)
    r.invalidate();
    expect(await r.get('RELAY_TRACE')).toBe('full');
  });
});

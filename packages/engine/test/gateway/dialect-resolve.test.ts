// 批次4 slice2 — offering → dialect resolution (§2.2/§2.3): channel override
// beats provider default; an unregistered {ref, version} pin is internal_error
// (方言未注册); DialectContext assembly (baseUrl / config / nowMs).
import { describe, expect, it } from 'vitest';

import { resolveDialectForOffering } from '../../src/index.js';
import { registryWith, stubDialect } from './gateway-fixtures.js';

const NOW_MS = 1_752_300_000_000;

describe('resolveDialectForOffering', () => {
  it('channel.dialect overrides provider.default_dialect (官方 vs 中转分叉点)', () => {
    const a = stubDialect({ ref: 'mock.a' });
    const b = stubDialect({ ref: 'mock.b' });
    const r = resolveDialectForOffering(
      { registry: registryWith(a, b) },
      {
        channel: {
          id: 'chan-1',
          dialect: { ref: 'mock.b', version: 'v1' },
          baseUrl: 'https://relay.example',
          region: null,
        },
        provider: { defaultDialect: { ref: 'mock.a', version: 'v1' } },
        nowMs: NOW_MS,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dialect.ref).toBe('mock.b');
  });

  it('channel inherits the provider default when it pins nothing', () => {
    const a = stubDialect({ ref: 'mock.a' });
    const r = resolveDialectForOffering(
      { registry: registryWith(a) },
      {
        channel: { id: 'chan-1', dialect: null, baseUrl: null, region: null },
        provider: { defaultDialect: { ref: 'mock.a', version: 'v1' } },
        nowMs: NOW_MS,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dialect.ref).toBe('mock.a');
  });

  it('unregistered {ref, version} → internal_error (方言未注册), version mismatch included', () => {
    const a = stubDialect({ ref: 'mock.a', version: 'v1' });
    const r = resolveDialectForOffering(
      { registry: registryWith(a) },
      {
        channel: {
          id: 'chan-1',
          dialect: { ref: 'mock.a', version: 'v2' },
          baseUrl: null,
          region: null,
        },
        provider: { defaultDialect: { ref: 'mock.a', version: 'v1' } },
        nowMs: NOW_MS,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('internal_error');
      expect(r.error.message).toContain('mock.a@v2');
    }
  });

  it('no channel pin AND no provider default → internal_error', () => {
    const r = resolveDialectForOffering(
      { registry: registryWith(stubDialect()) },
      {
        channel: { id: 'chan-1', dialect: null, baseUrl: null, region: null },
        provider: undefined,
        nowMs: NOW_MS,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
  });

  it('DialectContext: baseUrl from the channel; config carries region (channel wins) + callback template; nowMs injected', () => {
    const a = stubDialect({ ref: 'mock.a' });
    const r = resolveDialectForOffering(
      { registry: registryWith(a) },
      {
        channel: {
          id: 'chan-1',
          dialect: { ref: 'mock.a', version: 'v1' },
          baseUrl: 'https://up.example/v3',
          region: 'cn-beijing',
        },
        provider: {
          defaultDialect: null,
          region: 'us-east-1',
          callbackVerification: { scheme: 'hmac-sha256', header: 'x-sig' },
        },
        nowMs: NOW_MS,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx.baseUrl).toBe('https://up.example/v3');
    expect(r.ctx.nowMs).toBe(NOW_MS);
    expect(r.ctx.config).toEqual({
      region: 'cn-beijing', // channel region overrides the provider default
      callback_verification: { scheme: 'hmac-sha256', header: 'x-sig' },
    });
  });
});

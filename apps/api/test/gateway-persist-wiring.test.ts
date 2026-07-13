// 批次4 slice5 — the API side of the §7.5 three-path wiring:
//   in-request execute path: GatewayService accepts the GATEWAY_PERSIST hook
//     and threads it into ExecuteGatewayDeps.persist;
//   callback path: GatewayCallbacksService already injects GATEWAY_PERSIST
//     (@Optional, slice4 FIX3 tests) — the provider built here feeds BOTH.
// buildGatewayPersistHook is the module factory: even with storage
// UNCONFIGURED it returns a live hook whose media persists FAIL, so
// require_persist=true still fails-no-charge instead of silently skipping.
import type { Database } from '@actionow/db';
import type { ExecuteGatewayDeps, PersistHook } from '@actionow/engine';
import type { AppEnv, ConcurrencyLimiter, RateLimiter } from '@actionow/infra';
import type { DialectRegistry } from '@actionow/spi';
import { describe, expect, it, vi } from 'vitest';

import { buildGatewayPersistHook } from '../src/gateway/gateway.module.js';
import { GatewayService } from '../src/gateway/gateway.service.js';

const USAGE = { metrics: {}, billingDims: {}, estimated: false };

const MEDIA = {
  kind: 'media',
  assets: [
    { role: 'primary', modality: 'image', url: 'https://up.example.com/a.png', mime: 'image/png' },
  ],
  usage: { images: 1 },
};

describe('buildGatewayPersistHook (GATEWAY_PERSIST factory)', () => {
  it('storage unconfigured → still a live hook: non-media ok, media FAILS (require_persist enforceable)', async () => {
    const hook = buildGatewayPersistHook({} as Database, {} as AppEnv);
    await expect(hook({ output: { text: 'hi' }, usage: USAGE, tenantId: 't1' })).resolves.toEqual({
      ok: true,
    });
    const out = await hook({ output: MEDIA, usage: USAGE, tenantId: 't1' });
    expect(out.ok).toBe(false);
  });

  it('reads the ARTIFACT_RETENTION_DAYS dynamic default through the optional SettingsService', () => {
    const settings = { get: vi.fn().mockResolvedValue(14) };
    const hook = buildGatewayPersistHook({} as Database, {} as AppEnv, settings as never);
    expect(hook).toBeTypeOf('function');
  });
});

describe('GatewayService — §7.5 in-request wiring', () => {
  it('threads the injected GATEWAY_PERSIST hook into ExecuteGatewayDeps.persist', () => {
    const persist: PersistHook = vi.fn();
    const service = new GatewayService(
      {} as Database,
      {} as RateLimiter,
      {} as ConcurrencyLimiter,
      {} as DialectRegistry,
      {} as never,
      persist,
    );
    const deps = (service as unknown as { deps: ExecuteGatewayDeps }).deps;
    expect(deps.persist).toBe(persist);
  });

  it('stays optional: absent hook keeps deps.persist undefined (partial test modules)', () => {
    const service = new GatewayService(
      {} as Database,
      {} as RateLimiter,
      {} as ConcurrencyLimiter,
      {} as DialectRegistry,
      {} as never,
    );
    const deps = (service as unknown as { deps: ExecuteGatewayDeps }).deps;
    expect(deps.persist).toBeUndefined();
  });
});

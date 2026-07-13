// 批次4 slice6 — 切换预案② per-tenant gray-release hook unit tests: the pure
// resolution rule (explicit tenant opinion > platform default > false) and the
// composed read seam with injected fakes (no db).
import type { Database } from '@actionow/db';
import { describe, expect, it } from 'vitest';

import { isGatewayV2Tenant, resolveGatewayV2Enabled } from '../src/gateway/gray-release.js';

const DB = {} as Database;

describe('resolveGatewayV2Enabled (pure rule)', () => {
  it('an explicit tenant opinion wins over the platform default, both ways', () => {
    expect(resolveGatewayV2Enabled(true, false)).toBe(true);
    expect(resolveGatewayV2Enabled(false, true)).toBe(false);
  });

  it('no tenant opinion falls back to the platform default', () => {
    expect(resolveGatewayV2Enabled(undefined, true)).toBe(true);
    expect(resolveGatewayV2Enabled(undefined, false)).toBe(false);
  });
});

describe('isGatewayV2Tenant (read seam)', () => {
  it('reads the tenant flag first (internal tenant opted in while default off)', async () => {
    const enabled = await isGatewayV2Tenant(
      {
        db: DB,
        getPlatformDefault: () => Promise.resolve(false),
        getTenantFlag: (_db, tenantId) => {
          expect(tenantId).toBe('tenant-internal');
          return Promise.resolve(true);
        },
      },
      'tenant-internal',
    );
    expect(enabled).toBe(true);
  });

  it('a tenant with no opinion follows the GATEWAY_V2_DEFAULT platform setting', async () => {
    const enabled = await isGatewayV2Tenant(
      {
        db: DB,
        getPlatformDefault: () => Promise.resolve(true),
        getTenantFlag: () => Promise.resolve(undefined),
      },
      'tenant-any',
    );
    expect(enabled).toBe(true);
  });

  it('fails closed: no opinion anywhere ⇒ NOT migrated (default false)', async () => {
    const enabled = await isGatewayV2Tenant(
      {
        db: DB,
        getPlatformDefault: () => Promise.resolve(false),
        getTenantFlag: () => Promise.resolve(undefined),
      },
      'tenant-any',
    );
    expect(enabled).toBe(false);
  });

  it('an explicit tenant false OPTS OUT even when the platform default is on (回滚钩子)', async () => {
    const enabled = await isGatewayV2Tenant(
      {
        db: DB,
        getPlatformDefault: () => Promise.resolve(true),
        getTenantFlag: () => Promise.resolve(false),
      },
      'tenant-optout',
    );
    expect(enabled).toBe(false);
  });
});

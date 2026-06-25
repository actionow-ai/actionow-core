import { describe, expect, it } from 'vitest';

import { filterTenantNav, TENANT_NAV_CONFIG } from './app-nav';

/** All `to` paths across a nav config's desktop groups + mobile tabs. */
function allPaths(nav = TENANT_NAV_CONFIG): string[] {
  return [
    ...nav.groups.flatMap((g) => g.items.map((it) => it.to)),
    ...nav.mobileTabs.map((t) => t.to),
  ];
}

describe('filterTenantNav (RBAC v1 nav gating)', () => {
  it('keeps the full nav (incl. /app/members + /app/subjects) for a tenant admin', () => {
    const nav = filterTenantNav(true);
    expect(nav).toBe(TENANT_NAV_CONFIG);
    expect(allPaths(nav)).toContain('/app/members');
    expect(allPaths(nav)).toContain('/app/subjects');
  });

  it('strips the admin-only /app/members + /app/subjects items for a member', () => {
    const nav = filterTenantNav(false);
    expect(allPaths(nav)).not.toContain('/app/members');
    expect(allPaths(nav)).not.toContain('/app/subjects');
    // The non-admin items still render.
    expect(allPaths(nav)).toContain('/app/keys');
    expect(allPaths(nav)).toContain('/app/billing');
  });

  it('drops no group entirely (members keep the account group)', () => {
    const nav = filterTenantNav(false);
    expect(nav.groups.map((g) => g.key)).toEqual(TENANT_NAV_CONFIG.groups.map((g) => g.key));
  });
});

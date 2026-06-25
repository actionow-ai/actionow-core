import { filterTenantNav } from '../../components/console/app-nav';
import { ConsoleLayout } from '../../components/console/ConsoleLayout';
import { useTenantRole } from './useTenantRole';

/**
 * The `/app` shell wrapper (RBAC v1): resolves the caller's tenant seat and
 * renders the tenant `ConsoleLayout` with a role-filtered nav, so a
 * `tenant_role='member'` never sees the admin-only 成员管理 nav item. While the
 * role is loading we treat the caller as a member (the narrowest nav) — the item
 * appears once `me` resolves to an admin, never flashing for a member.
 */
export function TenantConsole() {
  const { isTenantAdmin } = useTenantRole();
  return <ConsoleLayout nav={filterTenantNav(isTenantAdmin)} />;
}

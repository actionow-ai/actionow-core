import { useQuery } from '@tanstack/react-query';

import { qk } from '../../lib/api/queryKeys';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';

/**
 * The caller's tenant-org seat (RBAC v1), read from `GET /console/me`'s
 * `tenant_role` — `'admin'` | `'member'` for tenant users, `null` for a system
 * operator. The `/app` surfaces gate their admin-only WRITES off `isTenantAdmin`
 * (a UX-only gate — the backend `TenantAdminGuard` is the real boundary, 403-ing
 * a member regardless of what the UI shows).
 *
 * NOTE: `tenant_role` is distinct from the synthetic `member` JWT role (which is
 * an end-user `subject`, `typ:'subject'`). A `null` role (system operator) is
 * treated as admin here — the operator owns the tenant outright. `isTenantAdmin`
 * stays `false` while `me` is loading, so a write control never flashes for a
 * member before the role resolves.
 */
export function useTenantRole(): {
  role: string | null | undefined;
  isTenantAdmin: boolean;
  isLoading: boolean;
} {
  const api = useConsoleApi();
  const me = useQuery({
    queryKey: qk.consoleMe(),
    queryFn: () => api.me(),
    staleTime: STALE_REFERENCE,
  });
  const role = me.data?.tenant_role;
  // A resolved `member` is the only seat that loses writes; `admin` and a `null`
  // operator both keep them. Unresolved (loading) → not yet admin, so we never
  // render a control a member would be 403'd on.
  const isTenantAdmin = me.isSuccess && role !== 'member';
  return { role, isTenantAdmin, isLoading: me.isLoading };
}

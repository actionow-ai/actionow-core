import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import type { MemberApi } from './memberApi';
import { makeMemberApi } from './memberApi';

/**
 * The end-user self-service client, bound to the authenticated member's token
 * (the same `client` raw transport `useAuth` exposes — it already carries the
 * member JWT stored by the `/member/login` flow).
 */
export function useMemberApi(): MemberApi {
  const { client } = useAuth();
  return useMemo(() => makeMemberApi(client), [client]);
}

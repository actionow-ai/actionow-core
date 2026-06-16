import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import type { AdminApi } from './admin';
import { makeAdminApi } from './admin';

export function useAdminApi(): AdminApi {
  const { client } = useAuth();
  return useMemo(() => makeAdminApi(client), [client]);
}

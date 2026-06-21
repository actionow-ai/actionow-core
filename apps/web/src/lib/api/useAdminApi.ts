import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import type { AdminApi } from './admin';
import { makeAdminApi } from './admin';

export function useAdminApi(): AdminApi {
  const { sdk, client, onUnauthorized } = useAuth();
  return useMemo(() => makeAdminApi(sdk, client, onUnauthorized), [sdk, client, onUnauthorized]);
}

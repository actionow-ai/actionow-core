import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import type { ConsoleApi } from './consoleApi';
import { makeConsoleApi } from './consoleApi';

/** The tenant self-service client, bound to the authenticated user's token. */
export function useConsoleApi(): ConsoleApi {
  const { sdk, client, onUnauthorized } = useAuth();
  return useMemo(() => makeConsoleApi(sdk, client, onUnauthorized), [sdk, client, onUnauthorized]);
}

import { useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider';
import type { ConsoleApi } from './consoleApi';
import { makeConsoleApi } from './consoleApi';

/** The tenant self-service client, bound to the authenticated user's token. */
export function useConsoleApi(): ConsoleApi {
  const { client } = useAuth();
  return useMemo(() => makeConsoleApi(client), [client]);
}

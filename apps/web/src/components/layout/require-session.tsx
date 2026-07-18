import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { Session } from '@/api/auth';
import { getSession, sessionPayload, subscribeSession } from '@/api/auth';

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession);
}

/** Route guard: requires a session; `admin` additionally requires the admin role claim. */
export function RequireSession({
  admin = false,
  children,
}: {
  admin?: boolean;
  children: ReactNode;
}) {
  const session = useSession();
  const location = useLocation();
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (admin && sessionPayload()?.role !== 'admin') {
    return <Navigate to="/app" replace />;
  }
  return children;
}

import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from './AuthProvider';

/** Guards a subtree. No `role` → any authenticated user. `role` → that role, else
 * bounce to the area the user can see. Unauthenticated → /login. */
export function ProtectedRoute({ role }: { role?: string }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/app" replace />;
  return <Outlet />;
}

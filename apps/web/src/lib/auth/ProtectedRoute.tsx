import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from './AuthProvider';
import { homePath } from './homePath';

/** Guards a subtree. No `role` → any authenticated operator (NOT a member, whose
 * token the operator planes reject and who has its own portal). `role` → that
 * role, else bounce to the area the user CAN see (its `homePath`).
 * Unauthenticated → /login. */
export function ProtectedRoute({ role }: { role?: string }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role !== undefined) {
    if (user.role !== role) return <Navigate to={homePath(user)} replace />;
  } else if (user.role === 'member') {
    return <Navigate to={homePath(user)} replace />;
  }
  return <Outlet />;
}

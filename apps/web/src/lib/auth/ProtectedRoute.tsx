import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from './AuthProvider';

export function ProtectedRoute() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/login" replace />;
  return <Outlet />;
}

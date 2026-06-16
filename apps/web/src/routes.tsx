import { Navigate, Route, Routes } from 'react-router-dom';

import { ConsoleLayout } from './components/console/ConsoleLayout';
import { LoginPage } from './features/auth/LoginPage';
import { AccountsPage } from './features/console/AccountsPage';
import { ApiKeysPage } from './features/console/ApiKeysPage';
import { DashboardPage } from './features/console/DashboardPage';
import { TenantsPage } from './features/console/TenantsPage';
import { LandingPage } from './features/landing/LandingPage';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/console" element={<ConsoleLayout />}>
          <Route index element={<Navigate to="/console/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

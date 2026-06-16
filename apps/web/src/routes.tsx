import { Navigate, Route, Routes } from 'react-router-dom';

import { ConsoleLayout } from './components/console/ConsoleLayout';
import { UserHome } from './features/app/UserHome';
import { AuthPage } from './features/auth/AuthPage';
import { AccountsPage } from './features/console/AccountsPage';
import { ApiKeysPage } from './features/console/ApiKeysPage';
import { DashboardPage } from './features/console/DashboardPage';
import { DifyImportPage } from './features/console/DifyImportPage';
import { ModifiersPage } from './features/console/ModifiersPage';
import { ResourceDetailPage } from './features/console/ResourceDetailPage';
import { ResourcesPage } from './features/console/ResourcesPage';
import { TenantsPage } from './features/console/TenantsPage';
import { LandingPage } from './features/landing/LandingPage';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<AuthPage />} />

      {/* Any authenticated user (tenant self-service home). */}
      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<UserHome />} />
      </Route>

      {/* Operator admin console. */}
      <Route element={<ProtectedRoute role="admin" />}>
        <Route path="/console" element={<ConsoleLayout />}>
          <Route index element={<Navigate to="/console/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="resources" element={<ResourcesPage />} />
          <Route path="resources/:id" element={<ResourceDetailPage />} />
          <Route path="modifiers" element={<ModifiersPage />} />
          <Route path="dify" element={<DifyImportPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

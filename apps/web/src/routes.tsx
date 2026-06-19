import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { ConsoleLayout } from './components/console/ConsoleLayout';
import { UserHome } from './features/app/UserHome';
import { AuthPage } from './features/auth/AuthPage';
import { AccountsPage } from './features/console/AccountsPage';
import { AnalyticsPage } from './features/console/AnalyticsPage';
import { ApiKeysPage } from './features/console/ApiKeysPage';
import { CatalogPage } from './features/console/CatalogPage';
import { DashboardPage } from './features/console/DashboardPage';
import { DifyImportPage } from './features/console/DifyImportPage';
import { ModifiersPage } from './features/console/ModifiersPage';
import { OfficialPricesPage } from './features/console/OfficialPricesPage';
import { RelayTracesPage } from './features/console/RelayTracesPage';
import { RouteGroupsPage } from './features/console/RouteGroupsPage';
import { TenantsPage } from './features/console/TenantsPage';
import { LandingPage } from './features/landing/LandingPage';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';

/** Redirect the legacy `/console/resources/:id` deep link into the unified catalog route, preserving the selected resource as `?id`. */
function ResourceRedirect() {
  const { id } = useParams();
  return (
    <Navigate to={`/console/catalog?tab=resources&id=${encodeURIComponent(id ?? '')}`} replace />
  );
}

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
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="relay-traces" element={<RelayTracesPage />} />
          <Route path="catalog" element={<CatalogPage />} />
          {/* Legacy routes redirect into the unified catalog page (single route + ?tab). */}
          <Route
            path="resources"
            element={<Navigate to="/console/catalog?tab=resources" replace />}
          />
          <Route path="resources/:id" element={<ResourceRedirect />} />
          <Route path="models" element={<Navigate to="/console/catalog?tab=models" replace />} />
          <Route path="modifiers" element={<ModifiersPage />} />
          {/* Billing & routing: mock-skeleton pages (the billing/routing backend
              is design-only; data layer lives in src/lib/api/mockBilling.ts). */}
          <Route path="groups" element={<RouteGroupsPage />} />
          <Route path="official-prices" element={<OfficialPricesPage />} />
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

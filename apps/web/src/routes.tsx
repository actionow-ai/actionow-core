import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { TENANT_NAV_CONFIG } from './components/console/app-nav';
import { ConsoleLayout } from './components/console/ConsoleLayout';
import { AppBilling } from './features/app/AppBilling';
import { AppKeys } from './features/app/AppKeys';
import { AppMedia } from './features/app/AppMedia';
import { AppModels } from './features/app/AppModels';
import { AppOverview } from './features/app/AppOverview';
import { AppSettings } from './features/app/AppSettings';
import { AppUsage } from './features/app/AppUsage';
import { AuthPage } from './features/auth/AuthPage';
import { AnalyticsPage } from './features/console/AnalyticsPage';
import { ApiKeysPage } from './features/console/ApiKeysPage';
import { CatalogPage } from './features/console/CatalogPage';
import { DashboardPage } from './features/console/DashboardPage';
import { DifyImportPage } from './features/console/DifyImportPage';
import { ModifiersPage } from './features/console/ModifiersPage';
import { OAuthSessionsPage } from './features/console/OAuthSessionsPage';
import { OfficialPricesPage } from './features/console/OfficialPricesPage';
import { RedemptionCodesPage } from './features/console/RedemptionCodesPage';
import { RelayTracesPage } from './features/console/RelayTracesPage';
import { RouteGroupsPage } from './features/console/RouteGroupsPage';
import { TenantsPage } from './features/console/TenantsPage';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';
import { RootRoute } from './RootRoute';

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
      <Route path="/" element={<RootRoute />} />
      <Route path="/login" element={<AuthPage />} />

      {/* Any authenticated user — the tenant self-service console (/app). */}
      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<ConsoleLayout nav={TENANT_NAV_CONFIG} />}>
          <Route index element={<Navigate to="/app/overview" replace />} />
          <Route path="overview" element={<AppOverview />} />
          <Route path="usage" element={<AppUsage />} />
          <Route path="media" element={<AppMedia />} />
          <Route path="keys" element={<AppKeys />} />
          <Route path="models" element={<AppModels />} />
          <Route path="billing" element={<AppBilling />} />
          <Route path="settings" element={<AppSettings />} />
        </Route>
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
          {/* Billing & routing: live on the real /admin/route-groups and
              /admin/official-prices endpoints (via useAdminApi). */}
          <Route path="groups" element={<RouteGroupsPage />} />
          <Route path="official-prices" element={<OfficialPricesPage />} />
          <Route path="dify" element={<DifyImportPage />} />
          <Route path="oauth-sessions" element={<OAuthSessionsPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          {/* Accounts merged into the Tenants hub (per-tenant detail drawer). */}
          <Route path="accounts" element={<Navigate to="/console/tenants" replace />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="redemption-codes" element={<RedemptionCodesPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

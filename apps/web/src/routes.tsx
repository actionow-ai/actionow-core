import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { ConsoleLayout } from './components/console/ConsoleLayout';
import { AppBilling } from './features/app/AppBilling';
import { AppKeys } from './features/app/AppKeys';
import { AppMedia } from './features/app/AppMedia';
import { AppModels } from './features/app/AppModels';
import { AppOverview } from './features/app/AppOverview';
import { AppSettings } from './features/app/AppSettings';
import { AppUsage } from './features/app/AppUsage';
import { MemberPortal } from './features/app/MemberPortal';
import { MembersPage } from './features/app/MembersPage';
import { TenantConsole } from './features/app/TenantConsole';
import { AuthPage } from './features/auth/AuthPage';
import { MemberAuthPage } from './features/auth/MemberAuthPage';
import { OAuthCallbackPage } from './features/auth/OAuthCallbackPage';
import { ApiKeysPage } from './features/console/ApiKeysPage';
import { AuditLogPage } from './features/console/AuditLogPage';
import { BreakersPage } from './features/console/BreakersPage';
import { DifyImportPage } from './features/console/DifyImportPage';
import { FaultPoliciesPage } from './features/console/FaultPoliciesPage';
import { LimitPlansPage } from './features/console/LimitPlansPage';
import { ModelAccessPage } from './features/console/ModelAccessPage';
import { ModelsCatalogPage } from './features/console/ModelsCatalogPage';
import { ModifiersPage } from './features/console/ModifiersPage';
import { OAuthSessionsPage } from './features/console/OAuthSessionsPage';
import { OfficialPricesPage } from './features/console/OfficialPricesPage';
import { OverviewPage } from './features/console/OverviewPage';
import { ProxiesPage } from './features/console/ProxiesPage';
import { RedemptionCodesPage } from './features/console/RedemptionCodesPage';
import { RelayTracesPage } from './features/console/RelayTracesPage';
import { ResourcesPage } from './features/console/ResourcesPage';
import { RouteGroupsPage } from './features/console/RouteGroupsPage';
import { ServiceTokensPage } from './features/console/ServiceTokensPage';
import { StatusPage } from './features/console/StatusPage';
import { TenantsPage } from './features/console/TenantsPage';
import { ProtectedRoute } from './lib/auth/ProtectedRoute';
import { RootRoute } from './RootRoute';

/** Redirect the legacy `/console/resources/:id` deep link into the platforms route, preserving the selected resource as `?id`. */
function ResourceRedirect() {
  const { id } = useParams();
  return <Navigate to={`/console/platforms?id=${encodeURIComponent(id ?? '')}`} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRoute />} />
      <Route path="/login" element={<AuthPage />} />
      {/* Member (end-user) auth — unified tenancy G-F (Model-A). */}
      <Route path="/member/login" element={<MemberAuthPage />} />
      {/* OAuth hand-off: backend 302s here with the JWT in the URL fragment. */}
      <Route path="/auth/callback" element={<OAuthCallbackPage />} />

      {/* Any authenticated operator user — the tenant self-service console (/app). */}
      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<TenantConsole />}>
          <Route index element={<Navigate to="/app/overview" replace />} />
          <Route path="overview" element={<AppOverview />} />
          <Route path="usage" element={<AppUsage />} />
          <Route path="media" element={<AppMedia />} />
          <Route path="keys" element={<AppKeys />} />
          <Route path="models" element={<AppModels />} />
          <Route path="billing" element={<AppBilling />} />
          {/* 成员管理 (Members) — tenant-admin-only (RBAC v1); the page self-gates
              for a member who deep-links here, and the nav item is hidden. */}
          <Route path="members" element={<MembersPage />} />
          <Route path="settings" element={<AppSettings />} />
        </Route>
      </Route>

      {/* Member (end-user) portal — its own plane (the operator /app + /console
          reject a member token). */}
      <Route element={<ProtectedRoute role="member" />}>
        <Route path="/portal" element={<MemberPortal />} />
      </Route>

      {/* Operator admin console. */}
      <Route element={<ProtectedRoute role="admin" />}>
        <Route path="/console" element={<ConsoleLayout />}>
          <Route index element={<Navigate to="/console/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          {/* dashboard + analytics merged into overview; keep old deep links working. */}
          <Route path="dashboard" element={<Navigate to="/console/overview" replace />} />
          <Route path="analytics" element={<Navigate to="/console/overview" replace />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="breakers" element={<BreakersPage />} />
          <Route path="relay-traces" element={<RelayTracesPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          {/* 模型接入 = the 3-pane (plugin → channel → model); the standalone 插件 page folds in here. */}
          <Route path="catalog" element={<ModelAccessPage />} />
          {/* Platform & pricing = the resource master-detail (pricebook + resource CRUD), secondary surface. */}
          <Route path="platforms" element={<ResourcesPage />} />
          {/* Legacy routes redirect into their new homes. */}
          <Route path="resources" element={<Navigate to="/console/platforms" replace />} />
          <Route path="resources/:id" element={<ResourceRedirect />} />
          <Route path="plugins" element={<Navigate to="/console/catalog" replace />} />
          <Route path="models" element={<ModelsCatalogPage />} />
          <Route path="proxies" element={<ProxiesPage />} />
          <Route path="modifiers" element={<ModifiersPage />} />
          {/* Billing & routing: live on the real /admin/route-groups and
              /admin/official-prices endpoints (via useAdminApi). */}
          <Route path="groups" element={<RouteGroupsPage />} />
          <Route path="limit-plans" element={<LimitPlansPage />} />
          <Route path="fault-policies" element={<FaultPoliciesPage />} />
          <Route path="official-prices" element={<OfficialPricesPage />} />
          <Route path="dify" element={<DifyImportPage />} />
          <Route path="oauth-sessions" element={<OAuthSessionsPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          {/* Accounts merged into the Tenants hub (per-tenant detail drawer). */}
          <Route path="accounts" element={<Navigate to="/console/tenants" replace />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="tokens" element={<ServiceTokensPage />} />
          <Route path="redemption-codes" element={<RedemptionCodesPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

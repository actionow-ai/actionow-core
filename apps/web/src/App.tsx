import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { sessionPayload } from '@/api/auth';
import { ConsoleShell } from '@/components/layout/console-shell';
import { RequireSession, useSession } from '@/components/layout/require-session';
import { TenantShell } from '@/components/layout/tenant-shell';
import { Skeleton } from '@/components/ui/data-display';

const LoginPage = lazy(() => import('@/pages/login-page').then((m) => ({ default: m.LoginPage })));
const AuthCallbackPage = lazy(() =>
  import('@/pages/auth-callback-page').then((m) => ({ default: m.AuthCallbackPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/not-found-page').then((m) => ({ default: m.NotFoundPage })),
);

// 管理台 /console — backed by /admin/*
const ConsoleOverviewPage = lazy(() =>
  import('@/pages/console/overview/overview-page').then((m) => ({
    default: m.ConsoleOverviewPage,
  })),
);
const ProvidersPage = lazy(() =>
  import('@/pages/console/supply-sources/providers-page').then((m) => ({
    default: m.ProvidersPage,
  })),
);
const ChannelsPage = lazy(() =>
  import('@/pages/console/supply-sources/channels-page').then((m) => ({
    default: m.ChannelsPage,
  })),
);
const ChannelDetailPage = lazy(() =>
  import('@/pages/console/supply-sources/channel-detail-page').then((m) => ({
    default: m.ChannelDetailPage,
  })),
);
const ModelsPage = lazy(() =>
  import('@/pages/console/supply-models/models-page').then((m) => ({ default: m.ModelsPage })),
);
const ModelDetailPage = lazy(() =>
  import('@/pages/console/supply-models/model-detail-page').then((m) => ({
    default: m.ModelDetailPage,
  })),
);
const OfferingsPage = lazy(() =>
  import('@/pages/console/supply-models/offerings-page').then((m) => ({
    default: m.OfferingsPage,
  })),
);
const PriceCardsPage = lazy(() =>
  import('@/pages/console/supply-models/price-cards-page').then((m) => ({
    default: m.PriceCardsPage,
  })),
);
const RouteGroupsPage = lazy(() =>
  import('@/pages/console/routing/groups-page').then((m) => ({ default: m.RouteGroupsPage })),
);
const FaultPoliciesPage = lazy(() =>
  import('@/pages/console/routing/fault-policies-page').then((m) => ({
    default: m.FaultPoliciesPage,
  })),
);
const ProxiesPage = lazy(() =>
  import('@/pages/console/routing/proxies-page').then((m) => ({ default: m.ProxiesPage })),
);
const BreakersPage = lazy(() =>
  import('@/pages/console/routing/breakers-page').then((m) => ({ default: m.BreakersPage })),
);
const TenantsPage = lazy(() =>
  import('@/pages/console/tenants/tenants-page').then((m) => ({ default: m.TenantsPage })),
);
const TenantDetailPage = lazy(() =>
  import('@/pages/console/tenants/tenant-detail-page').then((m) => ({
    default: m.TenantDetailPage,
  })),
);
const LedgerPage = lazy(() =>
  import('@/pages/console/billing/ledger-page').then((m) => ({ default: m.LedgerPage })),
);
const PaymentsPage = lazy(() =>
  import('@/pages/console/billing/payments-page').then((m) => ({ default: m.PaymentsPage })),
);
const RedemptionCodesPage = lazy(() =>
  import('@/pages/console/billing/redemption-codes-page').then((m) => ({
    default: m.RedemptionCodesPage,
  })),
);
const OfficialPricesPage = lazy(() =>
  import('@/pages/console/billing/official-prices-page').then((m) => ({
    default: m.OfficialPricesPage,
  })),
);
const ReconciliationPage = lazy(() =>
  import('@/pages/console/billing/reconciliation-page').then((m) => ({
    default: m.ReconciliationPage,
  })),
);
const LimitPlansPage = lazy(() =>
  import('@/pages/console/governance/plans-page').then((m) => ({ default: m.LimitPlansPage })),
);
const LimitMonitorPage = lazy(() =>
  import('@/pages/console/governance/monitor-page').then((m) => ({
    default: m.LimitMonitorPage,
  })),
);
const AuditLogPage = lazy(() =>
  import('@/pages/console/ops/audit-log-page').then((m) => ({ default: m.AuditLogPage })),
);
const RelayTracesPage = lazy(() =>
  import('@/pages/console/ops/relay-traces-page').then((m) => ({ default: m.RelayTracesPage })),
);
const UsageAnalyticsPage = lazy(() =>
  import('@/pages/console/ops/usage-page').then((m) => ({ default: m.UsageAnalyticsPage })),
);
const PlatformSettingsPage = lazy(() =>
  import('@/pages/console/settings/platform-page').then((m) => ({
    default: m.PlatformSettingsPage,
  })),
);
const SecretsPage = lazy(() =>
  import('@/pages/console/settings/secrets-page').then((m) => ({ default: m.SecretsPage })),
);
const AdminTokensPage = lazy(() =>
  import('@/pages/console/settings/tokens-page').then((m) => ({ default: m.AdminTokensPage })),
);
const OauthSessionsPage = lazy(() =>
  import('@/pages/console/settings/oauth-sessions-page').then((m) => ({
    default: m.OauthSessionsPage,
  })),
);

// 租户台 /app — backed by /console/*
const AppOverviewPage = lazy(() =>
  import('@/pages/app/core/overview-page').then((m) => ({ default: m.AppOverviewPage })),
);
const AppKeysPage = lazy(() =>
  import('@/pages/app/core/keys-page').then((m) => ({ default: m.AppKeysPage })),
);
const AppModelsPage = lazy(() =>
  import('@/pages/app/core/models-page').then((m) => ({ default: m.AppModelsPage })),
);
const AppUsagePage = lazy(() =>
  import('@/pages/app/core/usage-page').then((m) => ({ default: m.AppUsagePage })),
);
const SubjectsPage = lazy(() =>
  import('@/pages/app/users/subjects-page').then((m) => ({ default: m.SubjectsPage })),
);
const AppLimitPlansPage = lazy(() =>
  import('@/pages/app/users/limit-plans-page').then((m) => ({ default: m.AppLimitPlansPage })),
);
const TeamPage = lazy(() =>
  import('@/pages/app/users/team-page').then((m) => ({ default: m.TeamPage })),
);
const AppBillingPage = lazy(() =>
  import('@/pages/app/ops/billing-page').then((m) => ({ default: m.AppBillingPage })),
);
const FilesPage = lazy(() =>
  import('@/pages/app/ops/files-page').then((m) => ({ default: m.FilesPage })),
);
const AppSettingsPage = lazy(() =>
  import('@/pages/app/ops/settings-page').then((m) => ({ default: m.AppSettingsPage })),
);

function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4 p-2">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function RootRedirect() {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return (
    <Navigate
      to={sessionPayload()?.role === 'admin' ? '/console/overview' : '/app/overview'}
      replace
    />
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />

          <Route
            path="/console"
            element={
              <RequireSession admin>
                <ConsoleShell />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="overview" replace />} />
            <Route
              path="overview"
              element={
                <Suspense fallback={<RouteFallback />}>
                  <ConsoleOverviewPage />
                </Suspense>
              }
            />
            <Route path="supply/providers" element={<Lazy page={<ProvidersPage />} />} />
            <Route path="supply/channels" element={<Lazy page={<ChannelsPage />} />} />
            <Route path="supply/channels/:id" element={<Lazy page={<ChannelDetailPage />} />} />
            <Route path="supply/models" element={<Lazy page={<ModelsPage />} />} />
            <Route path="supply/models/:id" element={<Lazy page={<ModelDetailPage />} />} />
            <Route path="supply/offerings" element={<Lazy page={<OfferingsPage />} />} />
            <Route path="supply/price-cards" element={<Lazy page={<PriceCardsPage />} />} />
            <Route path="routing/groups" element={<Lazy page={<RouteGroupsPage />} />} />
            <Route path="routing/fault-policies" element={<Lazy page={<FaultPoliciesPage />} />} />
            <Route path="routing/proxies" element={<Lazy page={<ProxiesPage />} />} />
            <Route path="routing/breakers" element={<Lazy page={<BreakersPage />} />} />
            <Route path="tenants" element={<Lazy page={<TenantsPage />} />} />
            <Route path="tenants/:id" element={<Lazy page={<TenantDetailPage />} />} />
            <Route path="billing/ledger" element={<Lazy page={<LedgerPage />} />} />
            <Route path="billing/payments" element={<Lazy page={<PaymentsPage />} />} />
            <Route
              path="billing/redemption-codes"
              element={<Lazy page={<RedemptionCodesPage />} />}
            />
            <Route
              path="billing/official-prices"
              element={<Lazy page={<OfficialPricesPage />} />}
            />
            <Route path="billing/reconciliation" element={<Lazy page={<ReconciliationPage />} />} />
            <Route path="limits/plans" element={<Lazy page={<LimitPlansPage />} />} />
            <Route path="limits/monitor" element={<Lazy page={<LimitMonitorPage />} />} />
            <Route path="ops/audit-log" element={<Lazy page={<AuditLogPage />} />} />
            <Route path="ops/relay-traces" element={<Lazy page={<RelayTracesPage />} />} />
            <Route path="ops/usage" element={<Lazy page={<UsageAnalyticsPage />} />} />
            <Route path="settings/platform" element={<Lazy page={<PlatformSettingsPage />} />} />
            <Route path="settings/secrets" element={<Lazy page={<SecretsPage />} />} />
            <Route path="settings/tokens" element={<Lazy page={<AdminTokensPage />} />} />
            <Route path="settings/oauth-sessions" element={<Lazy page={<OauthSessionsPage />} />} />
            <Route path="*" element={<Lazy page={<NotFoundPage />} />} />
          </Route>

          <Route
            path="/app"
            element={
              <RequireSession>
                <TenantShell />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Lazy page={<AppOverviewPage />} />} />
            <Route path="keys" element={<Lazy page={<AppKeysPage />} />} />
            <Route path="models" element={<Lazy page={<AppModelsPage />} />} />
            <Route path="usage" element={<Lazy page={<AppUsagePage />} />} />
            <Route path="subjects" element={<Lazy page={<SubjectsPage />} />} />
            <Route path="limit-plans" element={<Lazy page={<AppLimitPlansPage />} />} />
            <Route path="team" element={<Lazy page={<TeamPage />} />} />
            <Route path="billing" element={<Lazy page={<AppBillingPage />} />} />
            <Route path="files" element={<Lazy page={<FilesPage />} />} />
            <Route path="settings" element={<Lazy page={<AppSettingsPage />} />} />
            <Route path="*" element={<Lazy page={<NotFoundPage />} />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

function Lazy({ page }: { page: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{page}</Suspense>;
}

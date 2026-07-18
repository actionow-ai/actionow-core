import { useQuery } from '@tanstack/react-query';
import { Building2, PlugZap, ScrollText, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { apiFetch, type PageOf, toApiStateError } from '@/api/client';
import { DateTimeText } from '@/components/common/date-time-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@/components/ui/data-display';

interface OpsSummary {
  tenants: number;
  resources: number;
  accounts: number;
}

interface BreakerRow {
  channel_id: string;
  channel_name: string | null;
  model: string;
  state: 'closed' | 'open' | 'half_open';
  failure_rate: number | null;
  trip_count: number;
  last_transition_at: string | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
}

const breakerVariant = { open: 'danger', half_open: 'warning', closed: 'success' } as const;

export function ConsoleOverviewPage() {
  const { t } = useTranslation();

  const summary = useQuery({
    queryKey: ['admin', 'summary'],
    queryFn: () => apiFetch<OpsSummary>('/admin/summary'),
  });
  const breakers = useQuery({
    queryKey: ['admin', 'breakers'],
    queryFn: () => apiFetch<BreakerRow[]>('/admin/breakers'),
  });
  const audit = useQuery({
    queryKey: ['admin', 'audit-log', 'recent'],
    queryFn: () => apiFetch<PageOf<AuditRow>>('/admin/audit-log', { query: { limit: 8 } }),
  });

  const openCount = breakers.data?.filter((row) => row.state !== 'closed').length;

  return (
    <PageTransition>
      <PageHeader
        title={t('consoleOverview.title')}
        description={t('consoleOverview.description')}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t('consoleOverview.statTenants')}
          detail={t('consoleOverview.statTenantsDetail')}
          value={summary.data ? String(summary.data.tenants) : '—'}
          icon={Building2}
          emphasis
          loading={summary.isLoading}
        />
        <StatCard
          title={t('consoleOverview.statAccounts')}
          detail={t('consoleOverview.statAccountsDetail')}
          value={summary.data ? String(summary.data.accounts) : '—'}
          icon={Wallet}
          loading={summary.isLoading}
        />
        <StatCard
          title={t('consoleOverview.statResources')}
          detail={t('consoleOverview.statResourcesDetail')}
          value={summary.data ? String(summary.data.resources) : '—'}
          icon={ScrollText}
          loading={summary.isLoading}
        />
        <StatCard
          title={t('consoleOverview.statOpenBreakers')}
          detail={t('consoleOverview.statOpenBreakersDetail')}
          value={openCount === undefined ? '—' : String(openCount)}
          icon={PlugZap}
          loading={breakers.isLoading}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">{t('consoleOverview.health')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('consoleOverview.healthDescription')}
              </p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/console/routing/breakers">{t('consoleOverview.viewBreakers')}</Link>
            </Button>
          </div>
          {breakers.isLoading ? (
            <ResourceLoading rows={3} />
          ) : breakers.isError ? (
            <ApiErrorNotice
              error={toApiStateError(breakers.error)}
              onRetry={() => void breakers.refetch()}
            />
          ) : !breakers.data || breakers.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('consoleOverview.healthEmpty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <DataTable className="min-w-full">
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('consoleOverview.colChannel')}</DataTableHead>
                    <DataTableHead>{t('consoleOverview.colModel')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('consoleOverview.colFailureRate')}</DataTableHead>
                    <DataTableHead>{t('consoleOverview.colTrips')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {breakers.data.slice(0, 8).map((row) => (
                    <DataTableRow key={`${row.channel_id}-${row.model}`}>
                      <DataTableCell>
                        {row.channel_name ?? row.channel_id.slice(0, 8)}
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.model}</DataTableCell>
                      <DataTableCell>
                        <Badge variant={breakerVariant[row.state]}>
                          {row.state === 'open'
                            ? t('consoleOverview.breakerOpen')
                            : row.state === 'half_open'
                              ? t('consoleOverview.breakerHalfOpen')
                              : t('consoleOverview.breakerClosed')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.failure_rate === null ? '—' : `${row.failure_rate.toFixed(1)}%`}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.trip_count}
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="text-sm font-semibold">{t('consoleOverview.latestAudit')}</h2>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/console/ops/audit-log">{t('consoleOverview.viewAudit')}</Link>
            </Button>
          </div>
          {audit.isLoading ? (
            <ResourceLoading rows={4} />
          ) : audit.isError ? (
            <ApiErrorNotice
              error={toApiStateError(audit.error)}
              onRetry={() => void audit.refetch()}
            />
          ) : !audit.data || audit.data.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('consoleOverview.auditEmpty')}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {audit.data.data.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{event.action}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {event.target_type}
                      {event.target_id ? ` · ${event.target_id.slice(0, 8)}` : ''}
                    </p>
                  </div>
                  <DateTimeText
                    value={event.created_at}
                    className="shrink-0 text-xs text-muted-foreground"
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </PageTransition>
  );
}

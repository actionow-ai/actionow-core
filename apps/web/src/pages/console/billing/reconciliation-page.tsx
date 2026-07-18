import type { DailyReconcileReport, ReconciliationReport } from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  CircleHelp,
  Coins,
  Scale,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, formatMicroCredits, toApiStateError } from '@/api/client';
import { FormField } from '@/components/common/form-field';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from '@/components/ui/components/animate/tabs';
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
import { Input } from '@/components/ui/input';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function utcDay(date: Date): string {
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const now = new Date();
const defaultFrom = `${String(now.getUTCFullYear())}-${pad(now.getUTCMonth() + 1)}-01`;
const defaultTo = utcDay(new Date(Date.now() + 24 * 60 * 60 * 1000));
const defaultDate = utcDay(new Date(Date.now() - 24 * 60 * 60 * 1000));

const scopeVariant = { official: 'primary', relay: 'neutral', unknown: 'warning' } as const;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function ReportTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ from: defaultFrom, to: defaultTo, tenantId: '' });
  const [applied, setApplied] = useState({ from: defaultFrom, to: defaultTo, tenantId: '' });

  const report = useQuery({
    queryKey: ['admin', 'reconciliation', 'report', applied],
    queryFn: () =>
      apiFetch<ReconciliationReport>('/admin/reconciliation/report', {
        query: {
          from: applied.from,
          to: applied.to,
          tenant_id: applied.tenantId === '' ? undefined : applied.tenantId,
        },
      }),
    enabled: applied.from !== '' && applied.to !== '',
  });

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ from: form.from, to: form.to, tenantId: form.tenantId.trim() });
          }}
        >
          <FormField label={t('billingAdmin.fieldFrom')} className="w-44">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.from}
                onChange={(event) => setForm((prev) => ({ ...prev, from: event.target.value }))}
              />
            )}
          </FormField>
          <FormField label={t('billingAdmin.fieldTo')} className="w-44">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.to}
                onChange={(event) => setForm((prev) => ({ ...prev, to: event.target.value }))}
              />
            )}
          </FormField>
          <FormField
            label={`${t('billingAdmin.tenantFilterLabel')}（${t('common.optional')}）`}
            className="min-w-64 flex-1"
          >
            {(id) => (
              <Input
                id={id}
                value={form.tenantId}
                onChange={(event) => setForm((prev) => ({ ...prev, tenantId: event.target.value }))}
                className="font-mono"
              />
            )}
          </FormField>
          <Button type="submit" variant="outline">
            {t('billingAdmin.apply')}
          </Button>
        </form>
      </Card>

      {report.isLoading ? (
        <ResourceLoading rows={4} />
      ) : report.isError ? (
        <ApiErrorNotice
          error={toApiStateError(report.error)}
          onRetry={() => void report.refetch()}
        />
      ) : report.data === undefined ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title={t('billingAdmin.statSettles')}
              value={String(report.data.totals.settle_count)}
              detail={t('billingAdmin.statSettlesDetail', {
                count: report.data.totals.estimated_count,
              })}
              icon={ScrollText}
              emphasis
            />
            <StatCard
              title={t('billingAdmin.statSale')}
              value={formatMicroCredits(report.data.totals.sale_side_credits)}
              detail={t('billingAdmin.statSaleDetail')}
              icon={Wallet}
            />
            <StatCard
              title={t('billingAdmin.statCost')}
              value={formatMicroCredits(report.data.totals.cost_side_credits)}
              detail={t('billingAdmin.statCostDetail', {
                count: report.data.totals.cost_missing_count,
              })}
              icon={Coins}
            />
            <StatCard
              title={t('billingAdmin.statMargin')}
              value={formatMicroCredits(report.data.totals.gross_margin_credits)}
              detail={t('billingAdmin.statMarginDetail')}
              icon={Scale}
            />
          </div>

          <Card>
            {report.data.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t('billingAdmin.reportEmpty')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <DataTable>
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('billingAdmin.colDay')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colTenant')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colOffering')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colChannel')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colModel')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colSettles')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colEstimated')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colCostMissing')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colSale')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colCost')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colMargin')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {report.data.rows.map((row) => (
                      <DataTableRow key={`${row.day}-${row.tenant_id}-${row.offering_id}`}>
                        <DataTableCell className="font-mono tabular-nums whitespace-nowrap">
                          {row.day}
                        </DataTableCell>
                        <DataTableCell className="font-mono text-sm">
                          {shortId(row.tenant_id)}
                        </DataTableCell>
                        <DataTableCell className="font-mono text-sm">
                          {shortId(row.offering_id)}
                        </DataTableCell>
                        <DataTableCell>{row.channel_name ?? '—'}</DataTableCell>
                        <DataTableCell className="font-mono text-sm">
                          {row.model ?? '—'}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {row.settle_count}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {row.estimated_count}
                        </DataTableCell>
                        <DataTableCell
                          className={
                            row.cost_missing_count > 0
                              ? 'font-mono tabular-nums text-danger'
                              : 'font-mono tabular-nums'
                          }
                        >
                          {row.cost_missing_count}
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.sale_side_credits} />
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.cost_side_credits} />
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText
                            value={row.gross_margin_credits}
                            className={
                              row.gross_margin_credits.startsWith('-') ? 'text-danger' : undefined
                            }
                          />
                        </DataTableCell>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function DailyTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ date: defaultDate, threshold: '' });
  const [applied, setApplied] = useState({ date: defaultDate, threshold: '' });

  const daily = useQuery({
    queryKey: ['admin', 'reconciliation', 'daily', applied],
    queryFn: () =>
      apiFetch<DailyReconcileReport>('/admin/reconciliation/daily', {
        query: {
          date: applied.date,
          threshold_pct: applied.threshold === '' ? undefined : applied.threshold,
        },
      }),
    enabled: applied.date !== '',
  });

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ date: form.date, threshold: form.threshold.trim() });
          }}
        >
          <FormField label={t('billingAdmin.fieldDate')} className="w-44">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
              />
            )}
          </FormField>
          <FormField
            label={`${t('billingAdmin.fieldThreshold')}（${t('common.optional')}）`}
            className="w-44"
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step="any"
                value={form.threshold}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, threshold: event.target.value }))
                }
              />
            )}
          </FormField>
          <Button type="submit" variant="outline">
            {t('billingAdmin.apply')}
          </Button>
        </form>
      </Card>

      {daily.isLoading ? (
        <ResourceLoading rows={4} />
      ) : daily.isError ? (
        <ApiErrorNotice error={toApiStateError(daily.error)} onRetry={() => void daily.refetch()} />
      ) : daily.data === undefined ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title={t('billingAdmin.statOfficial')}
              value={String(daily.data.official_count)}
              detail={t('billingAdmin.statOfficialDetail')}
              icon={ShieldCheck}
              emphasis
            />
            <StatCard
              title={t('billingAdmin.statRelay')}
              value={String(daily.data.relay_count)}
              detail={t('billingAdmin.statRelayDetail')}
              icon={ArrowLeftRight}
            />
            <StatCard
              title={t('billingAdmin.statUnknown')}
              value={String(daily.data.unknown_count)}
              detail={t('billingAdmin.statUnknownDetail')}
              icon={CircleHelp}
            />
            <StatCard
              title={t('billingAdmin.statAlerts')}
              value={String(daily.data.alerts_count)}
              detail={t('billingAdmin.statAlertsDetail', { pct: daily.data.threshold_pct })}
              icon={TriangleAlert}
            />
          </div>

          <Card>
            {daily.data.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t('billingAdmin.dailyEmpty')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <DataTable>
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('billingAdmin.colOffering')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colModel')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colChannel')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colScope')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colSettles')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colSale')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colCost')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colCompared')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colComparedCost')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colExpectedCost')}</DataTableHead>
                      <DataTableHead>{t('billingAdmin.colDeviation')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {daily.data.rows.map((row) => (
                      <DataTableRow key={row.offering_id}>
                        <DataTableCell className="font-mono text-sm">
                          {shortId(row.offering_id)}
                        </DataTableCell>
                        <DataTableCell className="font-mono text-sm">
                          {row.provider === null && row.model === null
                            ? '—'
                            : `${row.provider ?? '—'} / ${row.model ?? '—'}`}
                        </DataTableCell>
                        <DataTableCell>{row.channel_name ?? '—'}</DataTableCell>
                        <DataTableCell>
                          <Badge variant={scopeVariant[row.scope]}>
                            {row.scope === 'official'
                              ? t('billingAdmin.scopeOfficial')
                              : row.scope === 'relay'
                                ? t('billingAdmin.scopeRelay')
                                : t('billingAdmin.scopeUnknown')}
                          </Badge>
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {row.settle_count}
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.sale_credits} />
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.cost_credits} />
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {row.compared_settle_count}
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.compared_cost_credits} />
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.expected_cost_credits} />
                        </DataTableCell>
                        <DataTableCell className="whitespace-nowrap">
                          {row.deviation_pct === null ? (
                            '—'
                          ) : (
                            <span
                              className={
                                row.deviation_pct > 0
                                  ? 'font-mono tabular-nums text-danger'
                                  : 'font-mono tabular-nums'
                              }
                            >
                              {row.deviation_pct.toFixed(2)}%
                            </span>
                          )}{' '}
                          {row.alerted ? (
                            <Badge variant="danger">{t('billingAdmin.alertedYes')}</Badge>
                          ) : null}
                        </DataTableCell>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export function ReconciliationPage() {
  const { t } = useTranslation();
  return (
    <PageTransition>
      <PageHeader
        title={t('billingAdmin.reconTitle')}
        description={t('billingAdmin.reconDescription')}
      />

      <Tabs defaultValue="report">
        <TabsList className="mb-4">
          <TabsTrigger value="report">{t('billingAdmin.tabReport')}</TabsTrigger>
          <TabsTrigger value="daily">{t('billingAdmin.tabDaily')}</TabsTrigger>
        </TabsList>
        <TabsContents>
          <TabsContent value="report">
            <ReportTab />
          </TabsContent>
          <TabsContent value="daily">
            <DailyTab />
          </TabsContent>
        </TabsContents>
      </Tabs>
    </PageTransition>
  );
}

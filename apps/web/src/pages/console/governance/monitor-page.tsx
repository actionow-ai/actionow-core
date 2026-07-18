import type { LimitAlertView, LimitRuleStatusView, LimitUsageView } from '@actionow/contracts';
import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from '@/components/ui/components/animate/tabs';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type SubjectType = 'tenant' | 'key' | 'subject';

const SUBJECT_TYPES: SubjectType[] = ['tenant', 'key', 'subject'];

function useDebounced(value: string, delay = 400): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** used/cap are µ decimal strings for spend, plain counts otherwise. */
function AmountCell({ dimension, value }: { dimension: string; value: string }) {
  if (dimension === 'spend') return <MoneyText value={value} />;
  return <span className="font-mono tabular-nums">{value}</span>;
}

function utilizationPct(used: string, cap: string): number | null {
  const usedNum = Number(used);
  const capNum = Number(cap);
  if (!Number.isFinite(usedNum) || !Number.isFinite(capNum) || capNum <= 0) return null;
  return (usedNum / capNum) * 100;
}

export function LimitMonitorPage() {
  const { t } = useTranslation();

  const [subjectType, setSubjectType] = useState<SubjectType>('tenant');
  const [subjectId, setSubjectId] = useState('');
  const [planId, setPlanId] = useState('');
  const debouncedSubjectId = useDebounced(subjectId).trim();
  const debouncedPlanId = useDebounced(planId).trim();
  const ready = debouncedSubjectId !== '';

  const usage = useQuery({
    queryKey: ['admin', 'limits', 'usage', subjectType, debouncedSubjectId],
    queryFn: () =>
      apiFetch<LimitUsageView[]>('/admin/limits/usage', {
        query: { subjectType, subjectId: debouncedSubjectId },
      }),
    enabled: ready,
  });

  const status = useQuery({
    queryKey: ['admin', 'limits', 'status', subjectType, debouncedSubjectId, debouncedPlanId],
    queryFn: () =>
      apiFetch<LimitRuleStatusView[]>('/admin/limits/status', {
        query: {
          subjectType,
          subjectId: debouncedSubjectId,
          planId: debouncedPlanId === '' ? undefined : debouncedPlanId,
        },
      }),
    enabled: ready,
  });

  const alerts = useQuery({
    queryKey: ['admin', 'limits', 'alerts'],
    queryFn: () => apiFetch<LimitAlertView[]>('/admin/limits/alerts'),
  });

  const dimensionLabel = (dimension: string) =>
    SUBJECT_TYPES.length > 0 ? t(`governance.dimension_${dimension}`) : dimension;
  const periodLabel = (period: string | null) =>
    period === null || period === '' ? t('governance.noPeriod') : t(`governance.period_${period}`);
  const subjectTypeLabel = (type: string) => t(`governance.subject_${type}`);

  const subjectPrompt = (
    <EmptyState
      icon={Gauge}
      title={t('governance.promptTitle')}
      description={t('governance.promptDescription')}
    />
  );

  return (
    <PageTransition>
      <PageHeader
        title={t('governance.monitorTitle')}
        description={t('governance.monitorDescription')}
      />

      <Card className="mb-6 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t('governance.subjectType')}>
            {(id) => (
              <Select
                value={subjectType}
                onValueChange={(value) => setSubjectType(value as SubjectType)}
              >
                <SelectTrigger id={id} aria-label={t('governance.subjectType')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUBJECT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {subjectTypeLabel(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('governance.subjectId')}>
            {(id) => (
              <Input
                id={id}
                value={subjectId}
                onChange={(event) => setSubjectId(event.target.value)}
                placeholder={t('governance.subjectIdPlaceholder')}
                className="font-mono"
              />
            )}
          </FormField>
          <FormField label={t('governance.planIdFilter')} hint={t('governance.planIdHint')}>
            {(id) => (
              <Input
                id={id}
                value={planId}
                onChange={(event) => setPlanId(event.target.value)}
                className="font-mono"
              />
            )}
          </FormField>
        </div>
      </Card>

      <Tabs defaultValue="usage">
        <TabsList>
          <TabsTrigger value="usage">{t('governance.tabUsage')}</TabsTrigger>
          <TabsTrigger value="status">{t('governance.tabStatus')}</TabsTrigger>
          <TabsTrigger value="alerts">{t('governance.tabAlerts')}</TabsTrigger>
        </TabsList>
        <TabsContents>
          <TabsContent value="usage" className="pt-2">
            <Card className="overflow-hidden">
              <DataTableToolbar
                title={t('governance.tabUsage')}
                onRefresh={ready ? () => void usage.refetch() : undefined}
                refreshing={usage.isFetching}
              />
              {!ready ? (
                subjectPrompt
              ) : usage.isLoading ? (
                <div className="p-4">
                  <ResourceLoading rows={4} />
                </div>
              ) : usage.isError ? (
                <div className="p-4">
                  <ApiErrorNotice
                    error={toApiStateError(usage.error)}
                    onRetry={() => void usage.refetch()}
                  />
                </div>
              ) : !usage.data || usage.data.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t('governance.usageEmpty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead>{t('governance.colSubject')}</DataTableHead>
                        <DataTableHead>{t('governance.colDimension')}</DataTableHead>
                        <DataTableHead>{t('governance.colPeriodKey')}</DataTableHead>
                        <DataTableHead>{t('governance.colModelScope')}</DataTableHead>
                        <DataTableHead>{t('governance.colUsed')}</DataTableHead>
                        <DataTableHead>{t('governance.colPeriodStart')}</DataTableHead>
                        <DataTableHead>{t('common.updatedAt')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {usage.data.map((row) => (
                        <DataTableRow
                          key={`${row.subject_type}-${row.subject_id}-${row.dimension}-${row.period_key}-${row.model_scope}`}
                        >
                          <DataTableCell>
                            <span className="text-xs text-muted-foreground">
                              {subjectTypeLabel(row.subject_type)}
                            </span>
                            <span className="ml-2 font-mono text-sm">
                              {shortId(row.subject_id)}
                            </span>
                          </DataTableCell>
                          <DataTableCell>{dimensionLabel(row.dimension)}</DataTableCell>
                          <DataTableCell className="font-mono text-sm">
                            {row.period_key}
                          </DataTableCell>
                          <DataTableCell className="font-mono text-sm">
                            {row.model_scope}
                          </DataTableCell>
                          <DataTableCell>
                            <AmountCell dimension={row.dimension} value={row.used} />
                          </DataTableCell>
                          <DataTableCell>
                            <DateTimeText value={row.period_start} className="text-xs" />
                          </DataTableCell>
                          <DataTableCell>
                            <DateTimeText value={row.updated_at} className="text-xs" />
                          </DataTableCell>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="status" className="pt-2">
            <Card className="overflow-hidden">
              <DataTableToolbar
                title={t('governance.tabStatus')}
                onRefresh={ready ? () => void status.refetch() : undefined}
                refreshing={status.isFetching}
              />
              {!ready ? (
                subjectPrompt
              ) : status.isLoading ? (
                <div className="p-4">
                  <ResourceLoading rows={4} />
                </div>
              ) : status.isError ? (
                <div className="p-4">
                  <ApiErrorNotice
                    error={toApiStateError(status.error)}
                    onRetry={() => void status.refetch()}
                  />
                </div>
              ) : !status.data || status.data.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t('governance.statusEmpty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead>{t('governance.colDimension')}</DataTableHead>
                        <DataTableHead>{t('governance.colPeriodKey')}</DataTableHead>
                        <DataTableHead>{t('governance.colModelScope')}</DataTableHead>
                        <DataTableHead>{t('governance.colUsed')}</DataTableHead>
                        <DataTableHead>{t('governance.colCap')}</DataTableHead>
                        <DataTableHead>{t('governance.colPct')}</DataTableHead>
                        <DataTableHead>{t('governance.colAlertPct')}</DataTableHead>
                        <DataTableHead>{t('governance.colEnforce')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {status.data.map((row, index) => {
                        const pct = utilizationPct(row.used, row.cap);
                        return (
                          <DataTableRow
                            key={`${row.dimension}-${row.period ?? 'none'}-${row.model_scope ?? '*'}-${String(index)}`}
                          >
                            <DataTableCell>{dimensionLabel(row.dimension)}</DataTableCell>
                            <DataTableCell>{periodLabel(row.period)}</DataTableCell>
                            <DataTableCell className="font-mono text-sm">
                              {row.model_scope ?? '*'}
                            </DataTableCell>
                            <DataTableCell>
                              <AmountCell dimension={row.dimension} value={row.used} />
                            </DataTableCell>
                            <DataTableCell>
                              <AmountCell dimension={row.dimension} value={row.cap} />
                            </DataTableCell>
                            <DataTableCell>
                              <span
                                className={
                                  pct !== null && pct >= 100
                                    ? 'font-mono tabular-nums text-danger'
                                    : 'font-mono tabular-nums'
                                }
                              >
                                {pct === null ? '—' : `${pct.toFixed(1)}%`}
                              </span>
                            </DataTableCell>
                            <DataTableCell className="font-mono tabular-nums">
                              {row.alert_pct === null ? '—' : `${String(row.alert_pct)}%`}
                            </DataTableCell>
                            <DataTableCell>
                              <Badge variant="neutral">{row.enforce}</Badge>
                            </DataTableCell>
                          </DataTableRow>
                        );
                      })}
                    </DataTableBody>
                  </DataTable>
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="alerts" className="pt-2">
            <Card className="overflow-hidden">
              <DataTableToolbar
                title={t('governance.tabAlerts')}
                onRefresh={() => void alerts.refetch()}
                refreshing={alerts.isFetching}
              />
              {alerts.isLoading ? (
                <div className="p-4">
                  <ResourceLoading rows={4} />
                </div>
              ) : alerts.isError ? (
                <div className="p-4">
                  <ApiErrorNotice
                    error={toApiStateError(alerts.error)}
                    onRetry={() => void alerts.refetch()}
                  />
                </div>
              ) : !alerts.data || alerts.data.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t('governance.alertsEmpty')}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable>
                    <DataTableHeader>
                      <DataTableRow>
                        <DataTableHead>{t('governance.colFiredAt')}</DataTableHead>
                        <DataTableHead>{t('governance.colSubject')}</DataTableHead>
                        <DataTableHead>{t('governance.colDimension')}</DataTableHead>
                        <DataTableHead>{t('governance.colPeriodKey')}</DataTableHead>
                        <DataTableHead>{t('governance.colUsed')}</DataTableHead>
                        <DataTableHead>{t('governance.colCap')}</DataTableHead>
                        <DataTableHead>{t('governance.colPct')}</DataTableHead>
                      </DataTableRow>
                    </DataTableHeader>
                    <DataTableBody>
                      {alerts.data.map((row) => (
                        <DataTableRow key={row.id}>
                          <DataTableCell>
                            <DateTimeText value={row.created_at} className="text-xs" />
                          </DataTableCell>
                          <DataTableCell>
                            <span className="text-xs text-muted-foreground">
                              {subjectTypeLabel(row.subject_type)}
                            </span>
                            <span className="ml-2 font-mono text-sm">
                              {shortId(row.subject_id)}
                            </span>
                          </DataTableCell>
                          <DataTableCell>{dimensionLabel(row.dimension)}</DataTableCell>
                          <DataTableCell className="font-mono text-sm">
                            {row.period_key}
                          </DataTableCell>
                          <DataTableCell>
                            <AmountCell dimension={row.dimension} value={row.used} />
                          </DataTableCell>
                          <DataTableCell>
                            <AmountCell dimension={row.dimension} value={row.cap} />
                          </DataTableCell>
                          <DataTableCell>
                            <Badge variant={row.pct >= 100 ? 'danger' : 'warning'}>
                              {`${String(Math.round(row.pct))}%`}
                            </Badge>
                          </DataTableCell>
                        </DataTableRow>
                      ))}
                    </DataTableBody>
                  </DataTable>
                </div>
              )}
            </Card>
          </TabsContent>
        </TabsContents>
      </Tabs>
    </PageTransition>
  );
}

import type { RedeemCodesResult, RedemptionCodeView } from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { CopyButton } from '@/components/common/copy-button';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
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

type StatusFilter = 'all' | 'unused' | 'redeemed';

const codeStatusVariant: Record<string, 'success' | 'neutral'> = {
  unused: 'success',
  redeemed: 'neutral',
};

interface GenerateForm {
  count: string;
  creditsPerCode: string;
  maxUsesPerCode: string;
  expiresAt: string;
}

const emptyForm: GenerateForm = {
  count: '10',
  creditsPerCode: '',
  maxUsesPerCode: '1',
  expiresAt: '',
};

export function RedemptionCodesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<GenerateForm>(emptyForm);

  const query = useCursorQuery<RedemptionCodeView>({
    key: ['admin', 'redemption-codes'],
    path: '/admin/redemption-codes',
    query: { status: statusFilter === 'all' ? undefined : statusFilter },
  });

  const generate = useMutation({
    mutationFn: (body: {
      count: number;
      creditsPerCode: number;
      maxUsesPerCode: number;
      expiresAt?: string;
    }) => apiFetch<RedeemCodesResult>('/admin/redemption-codes', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'redemption-codes'] });
    },
  });

  const count = Number(form.count);
  const credits = Number(form.creditsPerCode);
  const maxUses = Number(form.maxUsesPerCode);
  const formValid =
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 1000 &&
    Number.isFinite(credits) &&
    credits > 0 &&
    Number.isInteger(maxUses) &&
    maxUses >= 1;

  const closeDialog = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setForm(emptyForm);
      generate.reset();
    }
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('billingAdmin.codesTitle')}
        description={t('billingAdmin.codesDescription')}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus />
            {t('billingAdmin.generateAction')}
          </Button>
        }
      />

      <Card>
        <DataTableToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <SelectTrigger className="w-44" aria-label={t('billingAdmin.statusFilterLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('billingAdmin.statusFilterAll')}</SelectItem>
              <SelectItem value="unused">{t('billingAdmin.codeStatusUnused')}</SelectItem>
              <SelectItem value="redeemed">{t('billingAdmin.codeStatusRedeemed')}</SelectItem>
            </SelectContent>
          </Select>
        </DataTableToolbar>

        {query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={5} />
          </div>
        ) : query.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(query.error)}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : query.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t('billingAdmin.codesEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('billingAdmin.colCode')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colCodeCredit')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colRedeemedOverMax')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colExpiresAt')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {query.rows.map((row) => (
                    <DataTableRow key={row.code}>
                      <DataTableCell>
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-sm">{row.code}</span>
                          <CopyButton value={row.code} />
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.credit_amount} />
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.redeemed_count} / {row.max_uses}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={codeStatusVariant[row.status] ?? 'neutral'}>
                          {row.status === 'unused'
                            ? t('billingAdmin.codeStatusUnused')
                            : row.status === 'redeemed'
                              ? t('billingAdmin.codeStatusRedeemed')
                              : row.status}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap">
                        {row.expires_at === null ? '—' : <DateTimeText value={row.expires_at} />}
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap">
                        <DateTimeText value={row.created_at} />
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="px-4 pb-4">
              <LoadMore
                count={query.rows.length}
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={closeDialog}>
        <DialogContent>
          {generate.data === undefined ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('billingAdmin.generateTitle')}</DialogTitle>
                <DialogDescription>{t('billingAdmin.generateDescription')}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4">
                <FormField label={t('billingAdmin.fieldCreditsPerCode')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      step="any"
                      value={form.creditsPerCode}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, creditsPerCode: event.target.value }))
                      }
                    />
                  )}
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t('billingAdmin.fieldCount')}
                    hint={t('billingAdmin.fieldCountHint')}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        max={1000}
                        step={1}
                        value={form.count}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, count: event.target.value }))
                        }
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t('billingAdmin.fieldMaxUses')}
                    hint={t('billingAdmin.fieldMaxUsesHint')}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        step={1}
                        value={form.maxUsesPerCode}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, maxUsesPerCode: event.target.value }))
                        }
                      />
                    )}
                  </FormField>
                </div>
                <FormField label={`${t('billingAdmin.fieldExpiresAt')}（${t('common.optional')}）`}>
                  {(id) => (
                    <Input
                      id={id}
                      type="datetime-local"
                      value={form.expiresAt}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, expiresAt: event.target.value }))
                      }
                    />
                  )}
                </FormField>
                {generate.isError ? (
                  <ApiErrorNotice error={toApiStateError(generate.error)} />
                ) : null}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => closeDialog(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  disabled={!formValid || generate.isPending}
                  onClick={() => {
                    generate.mutate({
                      count,
                      creditsPerCode: credits,
                      maxUsesPerCode: maxUses,
                      ...(form.expiresAt === ''
                        ? {}
                        : { expiresAt: new Date(form.expiresAt).toISOString() }),
                    });
                  }}
                >
                  {generate.isPending
                    ? t('billingAdmin.generatePending')
                    : t('billingAdmin.generateAction')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('billingAdmin.resultTitle', { count: generate.data.codes.length })}
                </DialogTitle>
                <DialogDescription>
                  {t('billingAdmin.resultDescription')}{' '}
                  <MoneyText value={generate.data.credit_amount} />
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto">
                {generate.data.codes.map((code) => (
                  <li key={code} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate font-mono text-sm">{code}</span>
                    <CopyButton value={code} />
                  </li>
                ))}
              </ul>
              <DialogFooter>
                <Button onClick={() => closeDialog(false)}>{t('common.close')}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

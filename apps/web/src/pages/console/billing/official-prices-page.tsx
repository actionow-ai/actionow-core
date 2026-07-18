import type { OfficialPriceView } from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
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
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input, Textarea } from '@/components/ui/input';

interface PriceForm {
  provider: string;
  modelSlug: string;
  displayName: string;
  inputUsd: string;
  outputUsd: string;
  cachedUsd: string;
  sourceUrl: string;
  effectiveAt: string;
  notes: string;
}

const emptyForm: PriceForm = {
  provider: '',
  modelSlug: '',
  displayName: '',
  inputUsd: '',
  outputUsd: '',
  cachedUsd: '',
  sourceUrl: '',
  effectiveAt: '',
  notes: '',
};

/** µUSD/1M decimal string → HUMAN USD/1M input prefill. */
function microToUsdInput(micro: string | null): string {
  if (micro === null || micro === '') return '';
  return String(Number(micro) / 1_000_000);
}

/** datetime-local input value → ISO instant; '' → undefined. */
function localToIso(value: string): string | undefined {
  return value === '' ? undefined : new Date(value).toISOString();
}

function isoToLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function rowToForm(row: OfficialPriceView): PriceForm {
  return {
    provider: row.provider,
    modelSlug: row.model_slug,
    displayName: row.display_name ?? '',
    inputUsd: microToUsdInput(row.input_price_per_1m),
    outputUsd: microToUsdInput(row.output_price_per_1m),
    cachedUsd: microToUsdInput(row.cached_input_price_per_1m),
    sourceUrl: row.source_url ?? '',
    effectiveAt: isoToLocalInput(row.effective_at),
    notes: row.notes ?? '',
  };
}

function PriceFormFields({
  form,
  setForm,
  mode,
}: {
  form: PriceForm;
  setForm: React.Dispatch<React.SetStateAction<PriceForm>>;
  mode: 'create' | 'edit';
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<PriceForm>) => setForm((prev) => ({ ...prev, ...patch }));
  return (
    <div className="grid gap-4">
      {mode === 'create' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('billingAdmin.fieldProvider')}>
            {(id) => (
              <Input
                id={id}
                value={form.provider}
                onChange={(event) => set({ provider: event.target.value })}
                placeholder="openai"
                className="font-mono"
              />
            )}
          </FormField>
          <FormField label={t('billingAdmin.fieldModelSlug')}>
            {(id) => (
              <Input
                id={id}
                value={form.modelSlug}
                onChange={(event) => set({ modelSlug: event.target.value })}
                className="font-mono"
              />
            )}
          </FormField>
        </div>
      ) : null}
      <FormField label={t('billingAdmin.fieldDisplayName')}>
        {(id) => (
          <Input
            id={id}
            value={form.displayName}
            onChange={(event) => set({ displayName: event.target.value })}
          />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('billingAdmin.fieldInputUsd')}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              step="any"
              value={form.inputUsd}
              onChange={(event) => set({ inputUsd: event.target.value })}
            />
          )}
        </FormField>
        <FormField label={t('billingAdmin.fieldOutputUsd')}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              step="any"
              value={form.outputUsd}
              onChange={(event) => set({ outputUsd: event.target.value })}
            />
          )}
        </FormField>
      </div>
      <FormField label={`${t('billingAdmin.fieldCachedUsd')}（${t('common.optional')}）`}>
        {(id) => (
          <Input
            id={id}
            type="number"
            min={0}
            step="any"
            value={form.cachedUsd}
            onChange={(event) => set({ cachedUsd: event.target.value })}
          />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={`${t('billingAdmin.fieldSourceUrl')}（${t('common.optional')}）`}>
          {(id) => (
            <Input
              id={id}
              value={form.sourceUrl}
              onChange={(event) => set({ sourceUrl: event.target.value })}
              placeholder="https://"
            />
          )}
        </FormField>
        <FormField label={`${t('billingAdmin.fieldEffectiveAt')}（${t('common.optional')}）`}>
          {(id) => (
            <Input
              id={id}
              type="datetime-local"
              value={form.effectiveAt}
              onChange={(event) => set({ effectiveAt: event.target.value })}
            />
          )}
        </FormField>
      </div>
      <FormField
        label={`${t('billingAdmin.fieldNotes')}（${t('common.optional')}）`}
        hint={mode === 'edit' ? t('billingAdmin.editClearHint') : undefined}
      >
        {(id) => (
          <Textarea
            id={id}
            value={form.notes}
            onChange={(event) => set({ notes: event.target.value })}
            className="min-h-16"
          />
        )}
      </FormField>
    </div>
  );
}

export function OfficialPricesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [providerInput, setProviderInput] = useState('');
  const [provider, setProvider] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState<OfficialPriceView | null>(null);
  const [deleteRow, setDeleteRow] = useState<OfficialPriceView | null>(null);
  const [form, setForm] = useState<PriceForm>(emptyForm);

  const query = useCursorQuery<OfficialPriceView>({
    key: ['admin', 'official-prices'],
    path: '/admin/official-prices',
    query: { provider: provider === '' ? undefined : provider },
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'official-prices'] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<OfficialPriceView>('/admin/official-prices', { method: 'POST', body }),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      setForm(emptyForm);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiFetch<OfficialPriceView>(`/admin/official-prices/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      invalidate();
      setEditRow(null);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/admin/official-prices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setDeleteRow(null);
    },
  });

  const inputUsd = Number(form.inputUsd);
  const outputUsd = Number(form.outputUsd);
  const pricesValid =
    Number.isFinite(inputUsd) && inputUsd > 0 && Number.isFinite(outputUsd) && outputUsd > 0;
  const createValid = form.provider.trim() !== '' && form.modelSlug.trim() !== '' && pricesValid;

  const openCreate = () => {
    setForm(emptyForm);
    create.reset();
    setCreateOpen(true);
  };
  const openEdit = (row: OfficialPriceView) => {
    setForm(rowToForm(row));
    update.reset();
    setEditRow(row);
  };

  const submitCreate = () => {
    create.mutate({
      provider: form.provider.trim(),
      modelSlug: form.modelSlug.trim(),
      ...(form.displayName === '' ? {} : { displayName: form.displayName }),
      inputUsdPer1m: inputUsd,
      outputUsdPer1m: outputUsd,
      ...(form.cachedUsd === '' ? {} : { cachedInputUsdPer1m: Number(form.cachedUsd) }),
      ...(form.sourceUrl === '' ? {} : { sourceUrl: form.sourceUrl }),
      ...(form.effectiveAt === '' ? {} : { effectiveAt: localToIso(form.effectiveAt) }),
      ...(form.notes === '' ? {} : { notes: form.notes }),
    });
  };

  const submitEdit = () => {
    if (editRow === null) return;
    update.mutate({
      id: editRow.id,
      body: {
        displayName: form.displayName === '' ? null : form.displayName,
        inputUsdPer1m: inputUsd,
        outputUsdPer1m: outputUsd,
        cachedInputUsdPer1m: form.cachedUsd === '' ? null : Number(form.cachedUsd),
        sourceUrl: form.sourceUrl === '' ? null : form.sourceUrl,
        effectiveAt: form.effectiveAt === '' ? null : localToIso(form.effectiveAt),
        notes: form.notes === '' ? null : form.notes,
      },
    });
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('billingAdmin.pricesTitle')}
        description={t('billingAdmin.pricesDescription')}
        actions={
          <Button onClick={openCreate}>
            <Plus />
            {t('billingAdmin.priceCreateAction')}
          </Button>
        }
      />

      {remove.isError ? (
        <ApiErrorNotice error={toApiStateError(remove.error)} className="mb-4" />
      ) : null}

      <Card>
        <DataTableToolbar onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
          <form
            className="flex min-w-64 flex-1 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setProvider(providerInput.trim());
            }}
          >
            <Input
              value={providerInput}
              onChange={(event) => setProviderInput(event.target.value)}
              placeholder={t('billingAdmin.providerFilterPlaceholder')}
              aria-label={t('billingAdmin.providerFilterLabel')}
              className="max-w-xs font-mono"
            />
            <Button type="submit" variant="outline">
              {t('billingAdmin.apply')}
            </Button>
          </form>
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
            {t('billingAdmin.pricesEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('billingAdmin.fieldProvider')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colModelSlug')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colDisplayName')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colInputPrice')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colOutputPrice')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colCachedPrice')}</DataTableHead>
                    <DataTableHead>{t('billingAdmin.colEffectiveAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {query.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>{row.provider}</DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.model_slug}</DataTableCell>
                      <DataTableCell>{row.display_name ?? '—'}</DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.input_price_per_1m} />
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.output_price_per_1m} />
                      </DataTableCell>
                      <DataTableCell>
                        <MoneyText value={row.cached_input_price_per_1m} />
                      </DataTableCell>
                      <DataTableCell className="whitespace-nowrap">
                        {row.effective_at === null ? (
                          '—'
                        ) : (
                          <DateTimeText value={row.effective_at} />
                        )}
                      </DataTableCell>
                      <DataTableCell className="text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('billingAdmin.editPriceLabel', { slug: row.model_slug })}
                          onClick={() => openEdit(row)}
                        >
                          <PencilLine />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('billingAdmin.deletePriceLabel', { slug: row.model_slug })}
                          onClick={() => setDeleteRow(row)}
                        >
                          <Trash2 />
                        </Button>
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('billingAdmin.priceCreateTitle')}</DialogTitle>
          </DialogHeader>
          <PriceFormFields form={form} setForm={setForm} mode="create" />
          {create.isError ? <ApiErrorNotice error={toApiStateError(create.error)} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!createValid || create.isPending} onClick={submitCreate}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editRow !== null} onOpenChange={(open) => !open && setEditRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('billingAdmin.priceEditTitle')}</DialogTitle>
            {editRow === null ? null : (
              <DialogDescription className="font-mono">
                {editRow.provider} / {editRow.model_slug}
              </DialogDescription>
            )}
          </DialogHeader>
          <PriceFormFields form={form} setForm={setForm} mode="edit" />
          {update.isError ? <ApiErrorNotice error={toApiStateError(update.error)} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!pricesValid || update.isPending} onClick={submitEdit}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteRow !== null}
        onOpenChange={(open) => !open && setDeleteRow(null)}
        title={t('billingAdmin.priceDeleteTitle')}
        description={
          deleteRow === null
            ? undefined
            : t('billingAdmin.priceDeleteDescription', { slug: deleteRow.model_slug })
        }
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteRow !== null) remove.mutate(deleteRow.id);
        }}
      />
    </PageTransition>
  );
}

import type {
  CreateSupplyPriceCardBody,
  CreateSupplyPriceCardVersionBody,
  PriceCard,
  PriceMethod,
  PriceSpec,
} from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Eye, GitBranch, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/components/radix/sheet';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PRICE_METHOD_OPTIONS: readonly PriceMethod[] = [
  'unit',
  'matrix',
  'fixed',
  'formula',
  'passthrough',
  'model_token',
  'credits',
];

const SPEC_PLACEHOLDER = '{"method":"unit","dimensions":{"request":{"rate":1000}}}';

/** Format a Date for a datetime-local Input value (local wall-clock). */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function PriceCardsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const cards = useCursorQuery<PriceCard>({
    key: ['admin', 'supply', 'price-cards'],
    path: '/admin/supply/price-cards',
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [method, setMethod] = useState<PriceMethod>('unit');
  const [unit, setUnit] = useState('');
  const [currency, setCurrency] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [specText, setSpecText] = useState('');
  const [specError, setSpecError] = useState<string | null>(null);

  const [versionTarget, setVersionTarget] = useState<PriceCard | null>(null);
  const [versionSpecText, setVersionSpecText] = useState('');
  const [versionEffectiveAt, setVersionEffectiveAt] = useState('');
  const [versionSpecError, setVersionSpecError] = useState<string | null>(null);

  const [viewTarget, setViewTarget] = useState<PriceCard | null>(null);

  const createCard = useMutation({
    mutationFn: (body: CreateSupplyPriceCardBody) =>
      apiFetch<PriceCard>('/admin/supply/price-cards', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'price-cards'] });
      setCreateOpen(false);
    },
  });

  const versionCard = useMutation({
    mutationFn: ({ cardId, body }: { cardId: string; body: CreateSupplyPriceCardVersionBody }) =>
      apiFetch<PriceCard>(`/admin/supply/price-cards/${cardId}/versions`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'supply', 'price-cards'] });
      setVersionTarget(null);
    },
  });

  const handleCreateOpenChange = (open: boolean) => {
    setCreateOpen(open);
    if (open) {
      setName('');
      setMethod('unit');
      setUnit('');
      setCurrency('');
      setEffectiveAt(toLocalInputValue(new Date()));
      setSpecText('');
      setSpecError(null);
      createCard.reset();
    }
  };

  const submitCreate = () => {
    if (name.trim() === '' || unit.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(specText);
    } catch {
      setSpecError(t('supplyModels.specInvalid'));
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { method?: unknown }).method !== method
    ) {
      setSpecError(t('supplyModels.specMethodMismatch'));
      return;
    }
    setSpecError(null);
    const effective = effectiveAt === '' ? new Date() : new Date(effectiveAt);
    createCard.mutate({
      name: name.trim(),
      method,
      unit: unit.trim(),
      spec: parsed as PriceSpec,
      effective_at: effective.toISOString(),
      ...(currency.trim() === '' ? {} : { currency: currency.trim() }),
    });
  };

  const openVersion = (card: PriceCard) => {
    setVersionSpecText(JSON.stringify(card.spec, null, 2));
    setVersionEffectiveAt(toLocalInputValue(new Date()));
    setVersionSpecError(null);
    versionCard.reset();
    setVersionTarget(card);
  };

  const submitVersion = () => {
    if (!versionTarget) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(versionSpecText);
    } catch {
      setVersionSpecError(t('supplyModels.specInvalid'));
      return;
    }
    const parsedMethod =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { method?: unknown }).method
        : undefined;
    if (
      typeof parsedMethod !== 'string' ||
      !(PRICE_METHOD_OPTIONS as readonly string[]).includes(parsedMethod)
    ) {
      setVersionSpecError(t('supplyModels.specMethodUnknown'));
      return;
    }
    setVersionSpecError(null);
    const effective = versionEffectiveAt === '' ? new Date() : new Date(versionEffectiveAt);
    versionCard.mutate({
      cardId: versionTarget.id,
      body: {
        method: parsedMethod as PriceMethod,
        spec: parsed as PriceSpec,
        effective_at: effective.toISOString(),
      },
    });
  };

  const createButton = (
    <Button onClick={() => handleCreateOpenChange(true)}>
      <Plus />
      {t('supplyModels.createCard')}
    </Button>
  );

  return (
    <PageTransition>
      <PageHeader
        title={t('supplyModels.priceCardsTitle')}
        description={t('supplyModels.priceCardsDescription')}
        actions={createButton}
      />

      {cards.isLoading ? (
        <ResourceLoading rows={5} />
      ) : cards.isError ? (
        <ApiErrorNotice error={toApiStateError(cards.error)} onRetry={() => void cards.refetch()} />
      ) : (
        <Card>
          <DataTableToolbar
            onRefresh={() => void cards.refetch()}
            refreshing={cards.isRefetching}
          />
          {cards.rows.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title={t('supplyModels.emptyPriceCardsTitle')}
              description={t('supplyModels.emptyPriceCardsDescription')}
              action={createButton}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <DataTable>
                  <DataTableHeader>
                    <DataTableRow>
                      <DataTableHead>{t('common.name')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colMethod')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colUnit')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colCurrency')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colVersion')}</DataTableHead>
                      <DataTableHead>{t('supplyModels.colEffectiveAt')}</DataTableHead>
                      <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {cards.rows.map((row) => (
                      <DataTableRow key={row.id}>
                        <DataTableCell>{row.name}</DataTableCell>
                        <DataTableCell className="font-mono text-sm">{row.method}</DataTableCell>
                        <DataTableCell>{row.unit}</DataTableCell>
                        <DataTableCell className="font-mono text-sm">{row.currency}</DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          v{row.version}
                        </DataTableCell>
                        <DataTableCell>
                          <DateTimeText value={row.effective_at} className="text-xs" />
                        </DataTableCell>
                        <DataTableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('supplyModels.actionViewSpec')}
                              onClick={() => setViewTarget(row)}
                            >
                              <Eye />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('supplyModels.actionNewVersion')}
                              onClick={() => openVersion(row)}
                            >
                              <GitBranch />
                            </Button>
                          </div>
                        </DataTableCell>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
              </div>
              <div className="px-4 pb-3">
                <LoadMore
                  count={cards.rows.length}
                  hasMore={cards.hasNextPage}
                  loading={cards.isFetchingNextPage}
                  onLoadMore={() => void cards.fetchNextPage()}
                />
              </div>
            </>
          )}
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.createCardTitle')}</DialogTitle>
            <DialogDescription>{t('supplyModels.createCardDescription')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <FormField label={t('common.name')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('supplyModels.fieldMethod')}>
                {(fieldId) => (
                  <Select value={method} onValueChange={(value) => setMethod(value as PriceMethod)}>
                    <SelectTrigger id={fieldId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRICE_METHOD_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option} className="font-mono">
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField label={t('supplyModels.fieldUnit')}>
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                    autoComplete="off"
                    required
                  />
                )}
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t('supplyModels.fieldCurrency')}
                hint={t('supplyModels.fieldCurrencyHint')}
              >
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    className="font-mono"
                    autoComplete="off"
                  />
                )}
              </FormField>
              <FormField label={t('supplyModels.fieldEffectiveAt')}>
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    type="datetime-local"
                    value={effectiveAt}
                    onChange={(event) => setEffectiveAt(event.target.value)}
                  />
                )}
              </FormField>
            </div>
            <FormField
              label={t('supplyModels.fieldSpec')}
              hint={t('supplyModels.fieldSpecHint')}
              error={specError ?? undefined}
            >
              {(fieldId) => (
                <Textarea
                  id={fieldId}
                  value={specText}
                  onChange={(event) => {
                    setSpecText(event.target.value);
                    setSpecError(null);
                  }}
                  className="min-h-32 font-mono text-xs"
                  placeholder={SPEC_PLACEHOLDER}
                  required
                />
              )}
            </FormField>
            {createCard.isError ? (
              <p className="text-sm text-danger">{toApiStateError(createCard.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleCreateOpenChange(false)}
                disabled={createCard.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={
                  createCard.isPending ||
                  name.trim() === '' ||
                  unit.trim() === '' ||
                  specText.trim() === ''
                }
              >
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={versionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVersionTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('supplyModels.newVersionTitle')}</DialogTitle>
            <DialogDescription>
              {t('supplyModels.newVersionDescription', { version: versionTarget?.version ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitVersion();
            }}
          >
            <FormField label={t('supplyModels.fieldEffectiveAt')}>
              {(fieldId) => (
                <Input
                  id={fieldId}
                  type="datetime-local"
                  value={versionEffectiveAt}
                  onChange={(event) => setVersionEffectiveAt(event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('supplyModels.fieldSpec')}
              hint={t('supplyModels.fieldSpecHint')}
              error={versionSpecError ?? undefined}
            >
              {(fieldId) => (
                <Textarea
                  id={fieldId}
                  value={versionSpecText}
                  onChange={(event) => {
                    setVersionSpecText(event.target.value);
                    setVersionSpecError(null);
                  }}
                  className="min-h-40 font-mono text-xs"
                  required
                />
              )}
            </FormField>
            {versionCard.isError ? (
              <p className="text-sm text-danger">{toApiStateError(versionCard.error).message}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setVersionTarget(null)}
                disabled={versionCard.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={versionCard.isPending || versionSpecText.trim() === ''}
              >
                {t('supplyModels.actionNewVersion')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Sheet
        open={viewTarget !== null}
        onOpenChange={(open) => {
          if (!open) setViewTarget(null);
        }}
      >
        <SheetContent side="right" className="w-[420px] sm:w-[480px]">
          <SheetHeader>
            <SheetTitle>{viewTarget?.name ?? ''}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <p className="mb-2 text-xs text-muted-foreground">
              {t('supplyModels.specSheetTitle')}
              {viewTarget ? (
                <span className="ml-2 font-mono tabular-nums">v{viewTarget.version}</span>
              ) : null}
            </p>
            <pre className="overflow-x-auto rounded-xl bg-surface-subtle p-4 font-mono text-xs leading-relaxed">
              {viewTarget ? JSON.stringify(viewTarget.spec, null, 2) : ''}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </PageTransition>
  );
}

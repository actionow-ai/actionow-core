import { ArrowSquareOutIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { Button } from '../../components/ui/Button';
import { ComboboxField } from '../../components/ui/ComboboxField';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DateField } from '../../components/ui/DateField';
import { Drawer } from '../../components/ui/Drawer';
import { FormField, useFieldId } from '../../components/ui/FormField';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { COMMON_PROVIDERS } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { OfficialPriceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/**
 * A µUSD/1M decimal string → human USD. The catalog magnitudes are tiny, so a
 * float divide is safe here (display only) — the WRITE path never multiplies
 * client-side; it sends human USD and the server converts to µUSD.
 */
function usdFromMicro(microStr: string): string {
  return (Number(microStr) / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/**
 * The 官方价格 (official model prices) console page — wired to the live
 * `/admin/official-prices` backend. A searchable/sortable `DataTable` of reference
 * prices, a create/edit `Drawer`, and per-row delete. The wire is asymmetric:
 * the backend RETURNS µUSD/1M decimal strings (snake_case) but ACCEPTS human
 * USD/1M (camelCase) on write, multiplying to µUSD itself. `effectiveAt` is a
 * full ISO-8601 timestamp.
 */
export function OfficialPricesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const list = useInfiniteQuery({
    queryKey: qk.officialPrices(),
    queryFn: ({ pageParam }) => api.listOfficialPrices({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<OfficialPriceView | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: OfficialPriceView) => api.deleteOfficialPrice(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.officialPrices() });
      toast(t('officialPrices.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setCreateOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('officialPrices.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<OfficialPriceView>[] = [
    {
      key: 'provider',
      header: t('officialPrices.cols.provider'),
      sortable: true,
      sortValue: (r) => r.provider,
      cell: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <ProviderIcon provider={r.provider} size={18} />
          {r.provider}
        </span>
      ),
      width: '160px',
    },
    {
      key: 'model_slug',
      header: t('officialPrices.cols.modelSlug'),
      grow: true,
      sortable: true,
      sortValue: (r) => r.model_slug,
      cell: (r) => <strong>{r.model_slug}</strong>,
    },
    {
      key: 'display_name',
      header: t('officialPrices.cols.displayName'),
      width: '220px',
      cell: (r) => r.display_name ?? '—',
    },
    {
      key: 'input',
      header: t('officialPrices.cols.inputPrice'),
      sortable: true,
      numeric: true,
      noClip: true,
      sortValue: (r) => Number(r.input_price_per_1m),
      cell: (r) => (
        <span className="tabular">
          ${usdFromMicro(r.input_price_per_1m)}
          <span style={{ color: 'var(--muted)' }}> /1M</span>
        </span>
      ),
      width: '128px',
    },
    {
      key: 'output',
      header: t('officialPrices.cols.outputPrice'),
      sortable: true,
      numeric: true,
      noClip: true,
      sortValue: (r) => Number(r.output_price_per_1m),
      cell: (r) => (
        <span className="tabular">
          ${usdFromMicro(r.output_price_per_1m)}
          <span style={{ color: 'var(--muted)' }}> /1M</span>
        </span>
      ),
      width: '128px',
    },
    {
      key: 'effective_at',
      header: t('officialPrices.cols.effectiveAt'),
      sortable: true,
      sortValue: (r) => r.effective_at ?? '',
      cell: (r) => <span className="tabular">{r.effective_at ? r.effective_at.slice(0, 10) : '—'}</span>,
      width: '120px',
    },
    {
      key: 'source',
      header: t('officialPrices.cols.source'),
      cell: (r) =>
        r.source_url !== null && r.source_url !== '' ? (
          <a
            href={r.source_url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-1)', color: 'var(--accent)' }}
          >
            {t('officialPrices.source')}
            <ArrowSquareOutIcon size={13} weight="bold" aria-hidden="true" />
          </a>
        ) : (
          '—'
        ),
      width: '104px',
    },
  ];

  return (
    // Consistent with the sibling list pages: no own scroll/padding wrapper, no
    // in-page title (the TopBar renders the title + subtitle).
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.isError}
        onRetry={() => void list.refetch()}
        empty={t('officialPrices.empty')}
        searchable
        actionsWidth="92px"
        rowActions={(r) => (
          <>
            <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEditId(r.id)} />
            <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDelTarget(r)} />
          </>
        )}
      />
      <LoadMore
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
      />

      {createOpen && <OfficialPriceEditor open onClose={() => setCreateOpen(false)} />}
      {editId !== null && (
        <OfficialPriceEditor
          key={editId}
          row={rows.find((p) => p.id === editId)}
          open
          onClose={() => setEditId(null)}
        />
      )}

      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('officialPrices.confirm.deleteTitle')}
        message={t('officialPrices.confirm.deleteMsg', { model: delTarget?.model_slug ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (delTarget) del.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </div>
  );
}

/** The effective-date form field: a labelled `FormField` wrapping the themed
 *  `DateField` (no native calendar / blue). */
function EffectiveDateField({
  label,
  value,
  onChange,
  hint,
  tooltip,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  tooltip?: string;
}) {
  const fieldId = useFieldId();
  return (
    <FormField id={fieldId} label={label} hint={hint} tooltip={tooltip}>
      <DateField value={value} onChange={onChange} ariaLabel={label} placeholder={label} />
    </FormField>
  );
}

/**
 * Create/edit `Drawer` for an official price. `row === undefined` → create.
 * Prices are entered in HUMAN USD per 1M tokens (the server stores µUSD); on edit
 * we convert the µUSD string back to USD to seed the form. `effectiveAt` is sent
 * as a full ISO timestamp (`yyyy-mm-dd` → `…T00:00:00Z`). Create requires positive
 * input/output prices; PATCH clears nullable fields with `null`.
 */
function OfficialPriceEditor({
  row,
  open,
  onClose,
}: {
  row?: OfficialPriceView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = row !== undefined;

  const usd = (s: string | null | undefined): number => (s ? Number(s) / 1_000_000 : 0);

  const [provider, setProvider] = useState(row?.provider ?? 'openai');
  const [modelSlug, setModelSlug] = useState(row?.model_slug ?? '');
  const [displayName, setDisplayName] = useState(row?.display_name ?? '');
  const [inputUsd, setInputUsd] = useState(usd(row?.input_price_per_1m));
  const [outputUsd, setOutputUsd] = useState(usd(row?.output_price_per_1m));
  const [cachedUsd, setCachedUsd] = useState(usd(row?.cached_input_price_per_1m));
  const [effectiveAt, setEffectiveAt] = useState(row?.effective_at ? row.effective_at.slice(0, 10) : '');
  const [sourceUrl, setSourceUrl] = useState(row?.source_url ?? '');
  const [notes, setNotes] = useState(row?.notes ?? '');

  useEffect(() => {
    if (row === undefined) return;
    setProvider(row.provider);
    setModelSlug(row.model_slug);
    setDisplayName(row.display_name ?? '');
    setInputUsd(usd(row.input_price_per_1m));
    setOutputUsd(usd(row.output_price_per_1m));
    setCachedUsd(usd(row.cached_input_price_per_1m));
    setEffectiveAt(row.effective_at ? row.effective_at.slice(0, 10) : '');
    setSourceUrl(row.source_url ?? '');
    setNotes(row.notes ?? '');
  }, [row]);

  const isoOrNull = (d: string): string | null => (d === '' ? null : `${d}T00:00:00Z`);
  // Create requires positive input/output prices + a model slug (mirrors the backend .positive()).
  const canSave = modelSlug.trim() !== '' && provider.trim() !== '' && (editing || (inputUsd > 0 && outputUsd > 0));

  const save = useMutation({
    mutationFn: () => {
      if (editing) {
        return api.updateOfficialPrice(row.id, {
          displayName: displayName.trim() === '' ? null : displayName.trim(),
          inputUsdPer1m: inputUsd,
          outputUsdPer1m: outputUsd,
          cachedInputUsdPer1m: cachedUsd > 0 ? cachedUsd : null,
          sourceUrl: sourceUrl.trim() === '' ? null : sourceUrl.trim(),
          effectiveAt: isoOrNull(effectiveAt),
          notes: notes.trim() === '' ? null : notes.trim(),
        });
      }
      return api.createOfficialPrice(
        {
          provider: provider.trim(),
          modelSlug: modelSlug.trim(),
          displayName: displayName.trim() === '' ? undefined : displayName.trim(),
          inputUsdPer1m: inputUsd,
          outputUsdPer1m: outputUsd,
          cachedInputUsdPer1m: cachedUsd > 0 ? cachedUsd : undefined,
          sourceUrl: sourceUrl.trim() === '' ? undefined : sourceUrl.trim(),
          effectiveAt: effectiveAt === '' ? undefined : `${effectiveAt}T00:00:00Z`,
          notes: notes.trim() === '' ? undefined : notes.trim(),
        },
        crypto.randomUUID(),
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.officialPrices() });
      toast(t(editing ? 'officialPrices.updated' : 'officialPrices.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  return (
    <Drawer
      open={open}
      title={t(editing ? 'officialPrices.editTitle' : 'officialPrices.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave}>
          {t('officialPrices.save')}
        </Button>
      }
    >
      <ComboboxField
        label={t('officialPrices.form.provider')}
        tooltip={t('officialPrices.tip.provider')}
        hint={COMMON_PROVIDERS.join(' · ')}
        options={[...COMMON_PROVIDERS]}
        value={provider}
        onChange={setProvider}
        required
        disabled={editing}
      />
      <TextField
        label={t('officialPrices.form.modelSlug')}
        tooltip={t('officialPrices.tip.modelSlug')}
        value={modelSlug}
        onChange={setModelSlug}
        required
        disabled={editing}
      />
      <TextField label={t('officialPrices.form.displayName')} value={displayName} onChange={setDisplayName} />
      <NumberField
        label={t('officialPrices.form.inputPrice')}
        tooltip={t('officialPrices.tip.price')}
        hint={t('officialPrices.priceEquiv', { usd: inputUsd.toFixed(2) })}
        value={inputUsd}
        onChange={setInputUsd}
        min={0}
        step={0.01}
      />
      <NumberField
        label={t('officialPrices.form.outputPrice')}
        tooltip={t('officialPrices.tip.price')}
        hint={t('officialPrices.priceEquiv', { usd: outputUsd.toFixed(2) })}
        value={outputUsd}
        onChange={setOutputUsd}
        min={0}
        step={0.01}
      />
      <NumberField
        label={t('officialPrices.form.cachedInputPrice')}
        tooltip={t('officialPrices.tip.cachedInputPrice')}
        hint={t('officialPrices.priceEquiv', { usd: cachedUsd.toFixed(2) })}
        value={cachedUsd}
        onChange={setCachedUsd}
        min={0}
        step={0.01}
      />
      <EffectiveDateField
        label={t('officialPrices.form.effectiveAt')}
        tooltip={t('officialPrices.tip.effectiveAt')}
        value={effectiveAt}
        onChange={setEffectiveAt}
      />
      <TextField
        label={t('officialPrices.form.sourceUrl')}
        tooltip={t('officialPrices.tip.sourceUrl')}
        type="url"
        value={sourceUrl}
        onChange={setSourceUrl}
      />
      <TextField label={t('officialPrices.form.notes')} value={notes} onChange={setNotes} />
    </Drawer>
  );
}

import { ArrowSquareOutIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { MockBadge } from '../../components/data/MockBadge';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { Button } from '../../components/ui/Button';
import { ComboboxField } from '../../components/ui/ComboboxField';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { FormField, useFieldId } from '../../components/ui/FormField';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { COMMON_PROVIDERS } from '../../lib/api/enums';
import {
  createOfficialPrice,
  deleteOfficialPrice,
  listOfficialPrices,
  updateOfficialPrice,
} from '../../lib/api/mockBilling';
import { mutationError } from '../../lib/api/mutationError';
import type { OfficialModelPrice } from '../../lib/api/types';

/** Query key for the mock official-price list (no backend → plain mock key). */
const QK = ['mock', 'official-prices'] as const;

/** µUSD/1M → a `$X.XX` dollar string (2dp, trims to integers cleanly). */
function usdLabel(microUsdPer1m: number): string {
  return (microUsdPer1m / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/**
 * The 官方价格 (official model prices) console page — a MOCK skeleton over the
 * in-memory `mockBilling` module (the billing backend is design-only). A
 * searchable/sortable `DataTable` of reference prices in USD per 1M tokens, with
 * a create/edit `Drawer` and per-row delete. A "演示数据" badge marks the page as
 * mock so it's never mistaken for live data. Prices are stored as integer µUSD
 * per 1M and shown as `$X.XX/1M`.
 */
export function OfficialPricesPage() {
  const { t } = useTranslation('console');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: QK, queryFn: listOfficialPrices });

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<OfficialModelPrice | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: OfficialModelPrice) => deleteOfficialPrice(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: QK });
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

  const cols: Column<OfficialModelPrice>[] = [
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
      sortable: true,
      sortValue: (r) => r.model_slug,
      cell: (r) => <strong>{r.model_slug}</strong>,
    },
    {
      key: 'display_name',
      header: t('officialPrices.cols.displayName'),
      cell: (r) => r.display_name,
    },
    {
      key: 'input',
      header: t('officialPrices.cols.inputPrice'),
      sortable: true,
      sortValue: (r) => r.input_price_per_1m,
      cell: (r) => (
        <span className="tabular">
          ${usdLabel(r.input_price_per_1m)}
          <span style={{ color: 'var(--muted)' }}> /1M</span>
        </span>
      ),
      width: '128px',
    },
    {
      key: 'output',
      header: t('officialPrices.cols.outputPrice'),
      sortable: true,
      sortValue: (r) => r.output_price_per_1m,
      cell: (r) => (
        <span className="tabular">
          ${usdLabel(r.output_price_per_1m)}
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
      cell: (r) => <span className="tabular">{r.effective_at ?? '—'}</span>,
      width: '120px',
    },
    {
      key: 'source',
      header: t('officialPrices.cols.source'),
      cell: (r) =>
        r.source_url !== undefined && r.source_url !== '' ? (
          <a
            href={r.source_url}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--s-1)',
              color: 'var(--accent)',
            }}
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
    <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--s-2) var(--s-3) var(--s-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          marginBottom: 'var(--s-3)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' }}>
          {t('officialPrices.title')}
        </h1>
        <MockBadge />
      </div>

      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('officialPrices.empty')}
        searchable
        pageSize={20}
        actionsWidth="92px"
        rowActions={(r) => (
          <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEditId(r.id)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setDelTarget(r)}
            />
          </div>
        )}
      />

      {createOpen && (
        <OfficialPriceEditor open onClose={() => setCreateOpen(false)} />
      )}
      {editId !== null && (
        <OfficialPriceEditor
          key={editId}
          row={(data ?? []).find((p) => p.id === editId)}
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

/** A native date input on the unified field contract (TextField has no date type). */
function DateField({
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
      <input
        id={fieldId}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="panel"
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          padding: '9px 11px',
          borderRadius: 'var(--r-sm)',
          outline: 'none',
        }}
      />
    </FormField>
  );
}

/**
 * Create/edit `Drawer` for an official price. `row === undefined` → create.
 * Prices are entered/stored as integer µUSD per 1M tokens; each price field shows
 * a `= $X.XX/1M` hint. Persists via the mock module + invalidates the query.
 */
function OfficialPriceEditor({
  row,
  open,
  onClose,
}: {
  row?: OfficialModelPrice;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const qc = useQueryClient();
  const editing = row !== undefined;

  const [provider, setProvider] = useState(row?.provider ?? 'openai');
  const [modelSlug, setModelSlug] = useState(row?.model_slug ?? '');
  const [displayName, setDisplayName] = useState(row?.display_name ?? '');
  const [inputPrice, setInputPrice] = useState(row?.input_price_per_1m ?? 0);
  const [outputPrice, setOutputPrice] = useState(row?.output_price_per_1m ?? 0);
  const [cachedPrice, setCachedPrice] = useState(row?.cached_input_price_per_1m ?? 0);
  const [effectiveAt, setEffectiveAt] = useState(row?.effective_at ?? '');
  const [sourceUrl, setSourceUrl] = useState(row?.source_url ?? '');
  const [notes, setNotes] = useState(row?.notes ?? '');

  // Re-seed when the edited row lands/changes (the page also keys edit by id).
  useEffect(() => {
    if (row === undefined) return;
    setProvider(row.provider);
    setModelSlug(row.model_slug);
    setDisplayName(row.display_name);
    setInputPrice(row.input_price_per_1m);
    setOutputPrice(row.output_price_per_1m);
    setCachedPrice(row.cached_input_price_per_1m ?? 0);
    setEffectiveAt(row.effective_at ?? '');
    setSourceUrl(row.source_url ?? '');
    setNotes(row.notes ?? '');
  }, [row]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        provider: provider.trim(),
        model_slug: modelSlug.trim(),
        display_name: displayName.trim(),
        input_price_per_1m: inputPrice,
        output_price_per_1m: outputPrice,
        cached_input_price_per_1m: cachedPrice > 0 ? cachedPrice : undefined,
        effective_at: effectiveAt === '' ? undefined : effectiveAt,
        source_url: sourceUrl.trim() === '' ? undefined : sourceUrl.trim(),
        notes: notes.trim() === '' ? undefined : notes.trim(),
      };
      return editing ? updateOfficialPrice(row.id, body) : createOfficialPrice(body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: QK });
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
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
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
      />
      <TextField
        label={t('officialPrices.form.modelSlug')}
        tooltip={t('officialPrices.tip.modelSlug')}
        value={modelSlug}
        onChange={setModelSlug}
        required
      />
      <TextField
        label={t('officialPrices.form.displayName')}
        value={displayName}
        onChange={setDisplayName}
      />
      <NumberField
        label={t('officialPrices.form.inputPrice')}
        tooltip={t('officialPrices.tip.price')}
        hint={t('officialPrices.priceEquiv', { usd: usdLabel(inputPrice) })}
        value={inputPrice}
        onChange={setInputPrice}
        min={0}
        step={1000}
      />
      <NumberField
        label={t('officialPrices.form.outputPrice')}
        tooltip={t('officialPrices.tip.price')}
        hint={t('officialPrices.priceEquiv', { usd: usdLabel(outputPrice) })}
        value={outputPrice}
        onChange={setOutputPrice}
        min={0}
        step={1000}
      />
      <NumberField
        label={t('officialPrices.form.cachedInputPrice')}
        tooltip={t('officialPrices.tip.cachedInputPrice')}
        hint={t('officialPrices.priceEquiv', { usd: usdLabel(cachedPrice) })}
        value={cachedPrice}
        onChange={setCachedPrice}
        min={0}
        step={1000}
      />
      <DateField
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

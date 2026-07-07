import { PencilSimpleIcon, PlusIcon, TrashIcon, UsersIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BrandIcon } from '../../components/data/BrandIcon';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { FacetBar } from './FacetBar';
import { ModelEditor } from './ModelEditor';
import { ModelGrantsDrawer } from './ModelGrantsDrawer';
import { useModelFacets } from './useModelFacets';

/** µUSD/1M string → `$X.XX`. */
function usd(micro: string): string {
  return `$${(Number(micro) / 1_000_000).toFixed(2)}`;
}

/**
 * The admin model CATALOG (catalog-tags-ia): a flat, faceted list of EVERY model
 * across all platforms — "what we serve" (browse), distinct from 接入设置 →
 * 模型接入 (the platform→通道→模型 wiring). Reuses the shared facet bar; a row opens
 * the ModelEditor.
 */
export function ModelsCatalogPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const models = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });

  const { filtered, facets } = useModelFacets(models.data ?? []);
  // A model name to edit, the sentinel 'new' (create), or null (closed).
  const [edit, setEdit] = useState<string | null>(null);
  // The model whose tenant grants are being managed / whose deletion is pending.
  const [grants, setGrants] = useState<string | null>(null);
  const [delTarget, setDelTarget] = useState<ModelView | undefined>(undefined);

  const qc = useQueryClient();
  const deleteModel = useMutation({
    mutationFn: (m: ModelView) => api.deleteModel(m.name),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('models.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setEdit('new')}>
        <PlusIcon size={14} weight="bold" /> {t('models.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<ModelView>[] = [
    {
      key: 'name',
      header: t('app.models.cols.name'),
      grow: true,
      cell: (r) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}
        >
          <BrandIcon icon={r.icon} fallbacks={[r.maker, r.modality]} size={16} />
          <span className="mono">{r.name}</span>
        </span>
      ),
    },
    { key: 'maker', header: t('facets.maker'), width: '120px', cell: (r) => r.maker ?? '—' },
    {
      key: 'modality',
      header: t('app.models.cols.modality'),
      width: '96px',
      cell: (r) => enumLabel(t, MODALITIES, r.modality),
    },
    {
      key: 'tags',
      header: t('facets.tag'),
      width: '170px',
      noClip: true,
      cell: (r) =>
        r.tags.length === 0 ? (
          '—'
        ) : (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
            {r.tags.map((tg) => (
              <span key={tg} className="chip">
                {tg}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'price',
      header: t('models.detail.price'),
      width: '120px',
      noClip: true,
      cell: (r) =>
        r.input_price === '0' && r.output_price === '0' ? (
          <span style={{ color: 'var(--muted)' }}>{t('models.unpriced')}</span>
        ) : (
          <span className="tabular">
            {usd(r.input_price)} / {usd(r.output_price)}
          </span>
        ),
    },
    {
      key: 'channels',
      // How many channels SERVE this model — not「模型」(the old key mislabeled it).
      header: t('models.cols.servedChannels'),
      width: '96px',
      numeric: true,
      cell: (r) => String(r.served_channel_ids.length),
    },
    {
      key: 'status',
      header: t('models.cols.status'),
      width: '100px',
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <FacetBar facets={facets} />
      <DataTable
        columns={cols}
        rows={filtered}
        rowKey={(r) => r.name}
        loading={models.isLoading}
        error={models.isError}
        onRetry={() => void models.refetch()}
        empty={t('models.empty')}
        searchable
        pageSize={25}
        onRowClick={(r) => setEdit(r.name)}
        actionsWidth="132px"
        rowActions={(r) => (
          <>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEdit(r.name)}
            />
            <RowAction
              icon={UsersIcon}
              label={t('models.actions.grants')}
              onClick={() => setGrants(r.name)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setDelTarget(r)}
            />
          </>
        )}
      />
      {edit !== null && (
        <ModelEditor
          key={edit}
          name={edit === 'new' ? undefined : edit}
          open
          onClose={() => setEdit(null)}
        />
      )}
      {grants !== null && (
        <ModelGrantsDrawer key={grants} name={grants} open onClose={() => setGrants(null)} />
      )}
      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('models.confirm.deleteTitle')}
        message={t('models.confirm.deleteMsg', { name: delTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deleteModel.isPending}
        onConfirm={() => {
          if (delTarget !== undefined) deleteModel.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </div>
  );
}

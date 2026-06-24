import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BrandIcon } from '../../components/data/BrandIcon';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { ModelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { ModelEditor } from './ModelEditor';
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

  const { node: facetBar, filtered } = useModelFacets(models.data ?? []);
  // A model name to edit, the sentinel 'new' (create), or null (closed).
  const [edit, setEdit] = useState<string | null>(null);

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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
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
      header: t('resources.detail.servedModels'),
      width: '72px',
      numeric: true,
      cell: (r) => String(r.served_channel_ids.length),
    },
    {
      key: 'status',
      header: t('app.models.cols.status', t('models.cols.status')),
      width: '100px',
      noClip: true,
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {facetBar}
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
      />
      {edit !== null && (
        <ModelEditor
          key={edit}
          name={edit === 'new' ? undefined : edit}
          open
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}

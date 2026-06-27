import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { CAPABILITIES, enumLabel, MODALITIES, VISIBILITIES } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleModelView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';
import { FacetBar } from '../console/FacetBar';
import { useModelFacets } from '../console/useModelFacets';

export function AppModels() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();

  const models = useQuery({
    queryKey: qk.consoleModels(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });

  const { filtered, facets } = useModelFacets(models.data ?? []);

  const cols: Column<ConsoleModelView>[] = [
    {
      key: 'name',
      header: t('app.models.cols.name'),
      grow: true,
      cell: (r) => <span className="mono">{r.name}</span>,
    },
    {
      key: 'display',
      header: t('app.models.cols.display'),
      width: '180px',
      cell: (r) => r.display || '—',
    },
    { key: 'maker', header: t('facets.maker'), width: '120px', cell: (r) => r.maker ?? '—' },
    {
      key: 'modality',
      header: t('app.models.cols.modality'),
      cell: (r) => enumLabel(t, MODALITIES, r.modality),
      width: '100px',
    },
    {
      key: 'tags',
      header: t('facets.tag'),
      width: '180px',
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
      key: 'visibility',
      header: t('app.models.cols.visibility'),
      noClip: true,
      cell: (r) => (
        <StatusBadge
          tone={r.visibility === 'public' ? 'ok' : 'idle'}
          label={enumLabel(t, VISIBILITIES, r.visibility)}
        />
      ),
      width: '110px',
    },
    {
      // The single most decision-relevant field for a tenant picking a model:
      // tools / vision / json / stream / audio. `capabilities` is free-form JSON
      // on the wire — read it as a record and chip the known flags that are on.
      key: 'capabilities',
      header: t('app.models.cols.capabilities'),
      width: '230px',
      noClip: true,
      cell: (r) => {
        const caps = (r.capabilities ?? {}) as Record<string, unknown>;
        const active = CAPABILITIES.filter((c) => caps[c.key] === true);
        if (active.length === 0) return '—';
        return (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
            {active.map((c) => (
              <span key={c.key} className="chip">
                {t(c.labelKey)}
              </span>
            ))}
          </span>
        );
      },
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
        empty={t('app.models.empty')}
        searchable
        pageSize={20}
      />
    </div>
  );
}

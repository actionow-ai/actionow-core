import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { enumLabel, MODALITIES, VISIBILITIES } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleModelView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';

export function AppModels() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();

  const models = useQuery({
    queryKey: qk.consoleModels(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });

  const cols: Column<ConsoleModelView>[] = [
    {
      key: 'name',
      header: t('app.models.cols.name'),
      cell: (r) => <span className="mono">{r.name}</span>,
    },
    { key: 'display', header: t('app.models.cols.display'), cell: (r) => r.display || '—' },
    {
      key: 'modality',
      header: t('app.models.cols.modality'),
      cell: (r) => enumLabel(t, MODALITIES, r.modality),
      width: '110px',
    },
    {
      key: 'visibility',
      header: t('app.models.cols.visibility'),
      cell: (r) => (
        <StatusBadge
          tone={r.visibility === 'public' ? 'ok' : 'idle'}
          label={enumLabel(t, VISIBILITIES, r.visibility)}
        />
      ),
      width: '110px',
    },
  ];

  return (
    <DataTable
      columns={cols}
      rows={models.data ?? []}
      rowKey={(r) => r.name}
      loading={models.isLoading}
      error={models.isError}
      onRetry={() => void models.refetch()}
      empty={t('app.models.empty')}
      searchable
      pageSize={20}
    />
  );
}

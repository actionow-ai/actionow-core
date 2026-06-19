import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Pill } from '../../components/ui/Pill';
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
      cell: (r) => r.modality,
      width: '110px',
    },
    {
      key: 'visibility',
      header: t('app.models.cols.visibility'),
      cell: (r) => <Pill tone={r.visibility === 'public' ? 'ok' : 'idle'}>{r.visibility}</Pill>,
      width: '110px',
    },
  ];

  return (
    <DataTable
      columns={cols}
      rows={models.data ?? []}
      rowKey={(r) => r.name}
      loading={models.isLoading}
      empty={t('app.models.empty')}
      searchable
      pageSize={20}
    />
  );
}

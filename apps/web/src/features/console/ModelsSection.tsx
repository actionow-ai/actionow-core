import {
  BracketsCurlyIcon,
  EyeIcon,
  type Icon,
  LightningIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
  WaveformIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { auditColumn } from '../../components/data/AuditBadge';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { CAPABILITIES, enumLabel, MODALITIES, VISIBILITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { useLatestAudit } from '../../lib/api/useLatestAudit';
import { STALE_REFERENCE } from '../../lib/query';
import { ModelEditor } from './ModelEditor';
import { ModelGrantsDrawer } from './ModelGrantsDrawer';

const CAP_ICON: Record<string, Icon> = {
  tools: WrenchIcon,
  vision: EyeIcon,
  audio: WaveformIcon,
  json: BracketsCurlyIcon,
  stream: LightningIcon,
};
const NEW = '__new__';

/**
 * The relay-models registry for ONE resource — the「模型」sub-tab of the resource
 * detail pane (catalog redesign: models nest under their parent resource instead
 * of a separate top-level tab). Lists `model` rows whose `resource_id` matches,
 * with create (resource pre-locked) / edit / tenant-grants / delete + bulk
 * enable-disable. Overlay state is local (not URL) so it doesn't clash with the
 * resource selection `?id`.
 */
export function ModelsSection({ resourceId }: { resourceId: string }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });
  const rows = useMemo(
    () => (data ?? []).filter((m) => m.resource_id === resourceId),
    [data, resourceId],
  );

  // Newest audit row per visible model → the "last changed" version badge. Model
  // audit rows key on the model NAME (the admin identifier), not a uuid.
  const audit = useLatestAudit(
    'model',
    rows.map((m) => m.name),
  );

  const [edit, setEdit] = useState<string>(''); // '' closed, NEW = create, else model name
  const [grants, setGrants] = useState('');
  const [delTarget, setDelTarget] = useState<ModelView | undefined>(undefined);

  // Bulk enable/disable via ONE `/admin/models/bulk` call (partial success), not
  // N parallel single-row PATCHes. The result toast reports succeeded/failed counts.
  const bulkSetStatus = useMutation({
    mutationFn: ({ rows: sel, action }: { rows: ModelView[]; action: 'enable' | 'disable'; clear: () => void }) =>
      api.bulkModels(
        action,
        sel.map((m) => m.name),
      ),
    onSuccess: async (r, { clear }) => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      clear();
      toast(t('admin.bulk.result', { ok: r.succeeded.length, failed: r.failed.length }));
    },
    onError: mutationError(t),
  });
  const deleteModel = useMutation({
    mutationFn: (m: ModelView) => api.deleteModel(m.name),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('models.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  const cols: Column<ModelView>[] = [
    {
      key: 'name',
      header: t('models.cols.model'),
      grow: true,
      sortable: true,
      sortValue: (m) => m.name,
      cell: (m) => (
        <span>
          <strong>{m.name}</strong>
          {m.display !== null && m.display !== '' && (
            <span style={{ color: 'var(--muted)' }}> · {m.display}</span>
          )}
        </span>
      ),
    },
    { key: 'modality', header: t('models.cols.modality'), cell: (m) => enumLabel(t, MODALITIES, m.modality), width: '96px' },
    {
      key: 'capabilities',
      header: t('models.cols.capabilities'),
      width: '128px',
      noClip: true,
      cell: (m) => {
        const active = CAPABILITIES.filter((c) => Object.hasOwn(m.capabilities, c.key) && m.capabilities[c.key]);
        if (active.length === 0) return '—';
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            {active.map((c) => {
              const CapIcon = CAP_ICON[c.key];
              if (CapIcon === undefined) return null;
              const label = t(c.labelKey);
              return (
                <span key={c.key} role="img" aria-label={label} title={label} style={{ display: 'inline-flex', color: 'var(--muted)' }}>
                  <CapIcon size={15} weight="bold" aria-hidden="true" />
                </span>
              );
            })}
          </span>
        );
      },
    },
    {
      key: 'inputPrice',
      header: t('models.cols.inputPrice'),
      numeric: true,
      noClip: true,
      width: '116px',
      sortable: true,
      sortValue: (m) => Number(m.input_price),
      cell: (m) => (
        <span className="tabular">
          {Number(m.input_price)}
          <span style={{ color: 'var(--muted)' }}> {t('models.perTok')}</span>
        </span>
      ),
    },
    {
      key: 'outputPrice',
      header: t('models.cols.outputPrice'),
      numeric: true,
      noClip: true,
      width: '116px',
      sortable: true,
      sortValue: (m) => Number(m.output_price),
      cell: (m) => (
        <span className="tabular">
          {Number(m.output_price)}
          <span style={{ color: 'var(--muted)' }}> {t('models.perTok')}</span>
        </span>
      ),
    },
    {
      key: 'visibility',
      header: t('models.cols.visibility'),
      width: '110px',
      noClip: true,
      cell: (m) => <span className="chip">{enumLabel(t, VISIBILITIES, m.visibility)}</span>,
    },
    {
      key: 'status',
      header: t('models.cols.status'),
      width: '100px',
      noClip: true,
      cell: (m) => <StatusBadge tone={statusTone(m.status)} label={t('status.' + m.status, m.status)} />,
    },
    auditColumn<ModelView>(t, audit, 'model', (m) => m.name),
  ];

  return (
    <>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(m) => m.name}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('models.empty')}
        searchable
        selectable
        pageSize={20}
        toolbarActions={
          <Button onClick={() => setEdit(NEW)}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.new')}
          </Button>
        }
        actionsWidth="132px"
        rowActions={(m) => (
          <>
            <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEdit(m.name)} />
            <RowAction icon={UsersIcon} label={t('models.actions.grants')} onClick={() => setGrants(m.name)} />
            <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDelTarget(m)} />
          </>
        )}
        bulkActions={(sel, clear) => (
          <>
            <Button variant="ghost" size="sm" onClick={() => bulkSetStatus.mutate({ rows: sel, action: 'enable', clear })}>
              {t('models.actions.enable')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => bulkSetStatus.mutate({ rows: sel, action: 'disable', clear })}>
              {t('models.actions.disable')}
            </Button>
          </>
        )}
      />

      <ModelEditor
        key={edit || 'new'}
        name={edit !== '' && edit !== NEW ? edit : undefined}
        fixedResourceId={resourceId}
        open={edit !== ''}
        onClose={() => setEdit('')}
      />
      {grants !== '' && (
        <ModelGrantsDrawer key={grants} name={grants} open={grants !== ''} onClose={() => setGrants('')} />
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
          if (delTarget) deleteModel.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </>
  );
}

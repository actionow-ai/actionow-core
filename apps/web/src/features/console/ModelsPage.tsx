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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { CAPABILITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';
import { ModelEditor } from './ModelEditor';
import { ModelGrantsDrawer } from './ModelGrantsDrawer';

/** Phosphor glyph per known capability flag, for the compact table chips. */
const CAP_ICON: Record<string, Icon> = {
  tools: WrenchIcon,
  vision: EyeIcon,
  audio: WaveformIcon,
  json: BracketsCurlyIcon,
  stream: LightningIcon,
};

const NEW = '__new__';

/**
 * The operator Models Registry: a full-width `DataTable` of relay models with a
 * create/edit drawer, a tenant-grants drawer, per-row delete, and bulk
 * enable/disable. Overlays are URL-stated (`edit` / `grants` hold the model
 * name, `edit === '__new__'` opens create) so they're deep-linkable and
 * refresh-safe. Prices are µcredit/token integers; capabilities render as chips.
 */
export function ModelsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
  });

  const [edit, setEdit] = useUrlState('edit');
  const [grants, setGrants] = useUrlState('grants');
  const [delTarget, setDelTarget] = useState<ModelView | undefined>(undefined);

  const bulkSetStatus = useMutation({
    mutationFn: async ({
      rows,
      status,
    }: {
      rows: ModelView[];
      status: 'active' | 'disabled';
      clear: () => void;
    }) => {
      await Promise.all(rows.map((m) => api.updateModel(m.name, { status })));
    },
    // Clear the selection only after the batch succeeds, so a failed bulk op
    // leaves the rows selected for an easy retry (vs. clearing optimistically).
    onSuccess: async (_data, { clear }) => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      clear();
      toast(t('models.statusUpdated'));
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

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setEdit(NEW)}>
        <PlusIcon size={14} weight="bold" /> {t('models.new')}
      </Button>
    ),
    [t, setEdit],
  );

  const cols: Column<ModelView>[] = [
    {
      key: 'name',
      header: t('models.cols.model'),
      sortable: true,
      sortValue: (m) => m.name,
      cell: (m) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
          <ProviderIcon provider={m.resource_id} size={18} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <strong>{m.name}</strong>
            {m.display !== null && m.display !== '' && (
              <span style={{ color: 'var(--muted)' }}> · {m.display}</span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: 'modality',
      header: t('models.cols.modality'),
      cell: (m) => m.modality,
      width: '96px',
    },
    {
      key: 'capabilities',
      header: t('models.cols.capabilities'),
      cell: (m) => {
        const active = CAPABILITIES.filter(
          (c) => Object.hasOwn(m.capabilities, c.key) && m.capabilities[c.key],
        );
        if (active.length === 0) return '—';
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            {active.map((c) => {
              const CapIcon = CAP_ICON[c.key];
              const label = t(c.labelKey);
              return (
                <span
                  key={c.key}
                  role="img"
                  aria-label={label}
                  title={label}
                  style={{ display: 'inline-flex', color: 'var(--muted)' }}
                >
                  <CapIcon size={15} weight="bold" aria-hidden="true" />
                </span>
              );
            })}
          </span>
        );
      },
      width: '128px',
    },
    {
      key: 'inputPrice',
      header: t('models.cols.inputPrice'),
      sortable: true,
      sortValue: (m) => Number(m.input_price),
      cell: (m) => (
        <span className="tabular">
          {Number(m.input_price)}
          <span style={{ color: 'var(--muted)' }}> /tok</span>
        </span>
      ),
      width: '116px',
    },
    {
      key: 'outputPrice',
      header: t('models.cols.outputPrice'),
      sortable: true,
      sortValue: (m) => Number(m.output_price),
      cell: (m) => (
        <span className="tabular">
          {Number(m.output_price)}
          <span style={{ color: 'var(--muted)' }}> /tok</span>
        </span>
      ),
      width: '116px',
    },
    {
      key: 'visibility',
      header: t('models.cols.visibility'),
      cell: (m) => (
        <span
          style={{
            fontSize: 'var(--fs-caption)',
            fontWeight: 600,
            padding: '3px 9px',
            borderRadius: 'var(--r-pill)',
            color: 'var(--muted)',
            background: 'var(--hover-bg)',
            border: '1px solid var(--panel-bd)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('enums.visibility.' + m.visibility, m.visibility)}
        </span>
      ),
      width: '110px',
    },
    {
      key: 'status',
      header: t('models.cols.status'),
      cell: (m) => <StatusBadge tone={statusTone(m.status)} label={t('status.' + m.status, m.status)} />,
      width: '100px',
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(m) => m.name}
        loading={isLoading}
        empty={t('models.empty')}
        searchable
        selectable
        pageSize={20}
        actionsWidth="132px"
        rowActions={(m) => (
          <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEdit(m.name)}
            />
            <RowAction
              icon={UsersIcon}
              label={t('models.actions.grants')}
              onClick={() => setGrants(m.name)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setDelTarget(m)}
            />
          </div>
        )}
        bulkActions={(sel, clear) => (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => bulkSetStatus.mutate({ rows: sel, status: 'active', clear })}
            >
              {t('models.actions.enable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => bulkSetStatus.mutate({ rows: sel, status: 'disabled', clear })}
            >
              {t('models.actions.disable')}
            </Button>
          </>
        )}
      />

      <ModelEditor
        key={edit || 'new'}
        name={edit !== '' && edit !== NEW ? edit : undefined}
        open={edit !== ''}
        onClose={() => setEdit('')}
      />
      {grants !== '' && (
        <ModelGrantsDrawer
          key={grants}
          name={grants}
          open={grants !== ''}
          onClose={() => setGrants('')}
        />
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
    </div>
  );
}

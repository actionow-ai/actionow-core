import { ArrowsClockwiseIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SelectField } from '../../components/ui/SelectField';
import { Tabs } from '../../components/ui/Tabs';
import { toast } from '../../components/ui/toast';
import { CHANNEL_STATUSES, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelStatus, ChannelView, PricebookView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';
import { ChannelEditor } from './ChannelEditor';
import { PricingModal } from './PricingModal';

/** The right pane of the Resources master-detail: tabbed overview / channels / pricing. */
export function ResourceDetailPane({ id }: { id: string }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const resources = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
  });
  const resource = (resources.data ?? []).find((r) => r.id === id);
  const channels = useQuery({
    queryKey: qk.channels(id),
    queryFn: () => api.listChannels(id),
    enabled: id !== '',
  });
  const pricebook = useQuery({
    queryKey: qk.pricebook(id),
    queryFn: () => api.listPricebook(id),
    enabled: id !== '',
  });

  const [tab, setTab] = useUrlState('tab', 'overview');

  const [chOpen, setChOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelView | undefined>(undefined);
  const [pbOpen, setPbOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<ChannelView | undefined>(undefined);

  const toggleStatus = useMutation({
    mutationFn: (c: ChannelView) =>
      api.updateChannel(id, c.id, { status: c.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
    },
    onError: mutationError(t),
  });
  const bulkSetStatus = useMutation({
    mutationFn: async ({ rows, status }: { rows: ChannelView[]; status: ChannelStatus }) => {
      await Promise.all(rows.map((c) => api.updateChannel(id, c.id, { status })));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
    },
    onError: mutationError(t),
  });
  const deleteChannel = useMutation({
    mutationFn: (c: ChannelView) => api.deleteChannel(id, c.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      toast(t('channels.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });
  const syncModels = useMutation({
    mutationFn: (c: ChannelView) => api.syncChannelModels(id, c.id, {}),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('channels.synced', { total: res.total }));
    },
    onError: mutationError(t),
  });
  const setResourceStatus = useMutation({
    mutationFn: (status: ChannelStatus) => api.updateResource(id, { status }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.resources() });
      toast(t('resources.statusUpdated'));
    },
    onError: mutationError(t),
  });

  const chCols: Column<ChannelView>[] = [
    {
      key: 'provider',
      header: t('channels.cols.provider'),
      cell: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <ProviderIcon provider={r.provider_type} size={18} />
          {r.provider_type}
        </span>
      ),
    },
    { key: 'endpoint', header: t('channels.cols.endpoint'), cell: (r) => r.endpoint ?? '—' },
    { key: 'model', header: t('channels.cols.model'), cell: (r) => r.model ?? '—' },
    {
      key: 'weight',
      header: t('channels.cols.weight'),
      cell: (r) => String(r.weight),
      width: '64px',
    },
    {
      key: 'status',
      header: t('channels.cols.status'),
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '96px',
    },
  ];

  const pbCols: Column<PricebookView>[] = [
    { key: 'method', header: t('pricebook.cols.method'), cell: (r) => r.method },
    { key: 'timing', header: t('pricebook.cols.timing'), cell: (r) => r.timing },
    { key: 'version', header: t('pricebook.cols.version'), cell: (r) => String(r.version) },
    {
      key: 'active',
      header: t('pricebook.cols.active'),
      cell: (r) => {
        const s = r.active ? 'active' : 'inactive';
        return <StatusBadge tone={statusTone(s)} label={t('status.' + s, s)} />;
      },
    },
  ];

  const overviewPanel = (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-4)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--s-3)',
      }}
    >
      {resource && <ProviderIcon provider={resource.provider_type} size={28} />}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 'var(--fs-lg)',
            fontWeight: 'var(--fw-semibold)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {id}
        </div>
        {resource && (
          <div
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--muted)',
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <span>
              {resource.modality} · {resource.provider_type} · {resource.exec_modes.join(', ')}
            </span>
            <StatusBadge
              tone={statusTone(resource.status)}
              label={t('status.' + resource.status, resource.status)}
            />
            <span style={{ color: 'var(--faint)' }}>v{resource.current_version}</span>
          </div>
        )}
        {resource && (
          <div style={{ marginTop: 'var(--s-3)', maxWidth: 220 }}>
            <SelectField
              label={t('resources.actions.setStatus')}
              value={resource.status === 'active' ? 'active' : 'disabled'}
              onChange={(v) => setResourceStatus.mutate(v as ChannelStatus)}
              options={toOptions(CHANNEL_STATUSES, t)}
            />
          </div>
        )}
      </div>
    </div>
  );

  const channelsPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setChOpen(true);
          }}
        >
          <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('resources.detail.addChannel')}
        </Button>
      </div>
      <DataTable
        columns={chCols}
        rows={channels.data ?? []}
        rowKey={(r) => r.id}
        loading={channels.isLoading}
        empty={t('channels.empty')}
        searchable
        selectable
        rowActions={(r) => (
          <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(r);
                setChOpen(true);
              }}
            >
              {t('common.edit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => toggleStatus.mutate(r)}>
              {r.status === 'active' ? t('channels.actions.disable') : t('channels.actions.enable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => syncModels.mutate(r)}
              loading={syncModels.isPending && syncModels.variables.id === r.id}
            >
              <ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" />{' '}
              {t('channels.actions.syncModels')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDelTarget(r)}>
              <TrashIcon size={14} weight="bold" aria-hidden="true" /> {t('channels.actions.delete')}
            </Button>
          </div>
        )}
        bulkActions={(sel, clear) => (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                bulkSetStatus.mutate({ rows: sel, status: 'active' });
                clear();
              }}
            >
              {t('channels.actions.enable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                bulkSetStatus.mutate({ rows: sel, status: 'disabled' });
                clear();
              }}
            >
              {t('channels.actions.disable')}
            </Button>
          </>
        )}
      />
    </div>
  );

  const pricingPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div>
        <Button onClick={() => setPbOpen(true)}>
          <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('resources.detail.addPrice')}
        </Button>
      </div>
      <DataTable
        columns={pbCols}
        rows={pricebook.data ?? []}
        rowKey={(r) => r.id}
        loading={pricebook.isLoading}
        empty={t('pricebook.empty')}
        searchable
        pageSize={10}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <Tabs
        value={tab}
        onChange={setTab}
        ariaLabel={t('resources.detail.tabsLabel')}
        tabs={[
          { value: 'overview', label: t('resources.tabs.overview') },
          { value: 'channels', label: t('resources.tabs.channels') },
          { value: 'pricing', label: t('resources.tabs.pricing') },
        ]}
      >
        {tab === 'channels' ? channelsPanel : tab === 'pricing' ? pricingPanel : overviewPanel}
      </Tabs>

      <ChannelEditor
        key={editing?.id ?? 'new'}
        resourceId={id}
        channel={editing}
        open={chOpen}
        onClose={() => setChOpen(false)}
      />
      <PricingModal
        key={pbOpen ? 'open' : 'closed'}
        resourceId={id}
        resourceCurrentVersion={resource?.current_version ?? 1}
        open={pbOpen}
        onClose={() => setPbOpen(false)}
      />
      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('confirm.deleteChannelTitle')}
        message={t('confirm.deleteChannelMsg', {
          provider: delTarget?.provider_type ?? '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deleteChannel.isPending}
        onConfirm={() => {
          if (delTarget) deleteChannel.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </div>
  );
}

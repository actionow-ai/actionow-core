import {
  ArrowsClockwiseIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import {
  CHANNEL_STATUSES,
  enumLabel,
  PRICEBOOK_METHODS,
  PRICEBOOK_TIMINGS,
  toOptions,
} from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelStatus, ChannelView, PricebookView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { ChannelEditor } from './ChannelEditor';
import { PricingModal } from './PricingModal';

/**
 * A labelled section block for the merged detail pane: an uppercase muted
 * heading above its content, used to stack overview / channels / pricing in one
 * scrolling column (no tabs).
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <h2
        style={{
          margin: 0,
          fontSize: 'var(--fs-caption)',
          fontWeight: 600,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The right pane of the Resources master-detail: one scrolling pane that stacks overview / channels / pricing as sections. */
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

  const [chOpen, setChOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelView | undefined>(undefined);
  const [pbOpen, setPbOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<ChannelView | undefined>(undefined);
  const [pbDelTarget, setPbDelTarget] = useState<PricebookView | undefined>(undefined);

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
  // Pricebook entries are versioned (a re-price is a NEW version via PricingModal),
  // so in-place edits are just enable/disable + delete — closing the price table's
  // formerly-dead `active` affordance.
  const togglePbActive = useMutation({
    mutationFn: (r: PricebookView) => api.updatePricebook(r.id, { active: !r.active }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.pricebook(id) });
    },
    onError: mutationError(t),
  });
  const deletePb = useMutation({
    mutationFn: (r: PricebookView) => api.deletePricebook(r.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.pricebook(id) });
      toast(t('pricebook.deleted'));
      setPbDelTarget(undefined);
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
      key: 'cost',
      header: t('channels.cols.cost'),
      cell: (r) => {
        // µUSD/1M strings → human USD for display; '—' per side when unset.
        const usd = (m: string | null) =>
          m === null ? '—' : `$${(Number(m) / 1_000_000).toFixed(2)}`;
        if (r.input_cost_per_1m === null && r.output_cost_per_1m === null) return '—';
        return (
          <span className="tabular" style={{ whiteSpace: 'nowrap' }}>
            {usd(r.input_cost_per_1m)} / {usd(r.output_cost_per_1m)}
          </span>
        );
      },
      width: '120px',
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
    {
      key: 'method',
      header: t('pricebook.cols.method'),
      cell: (r) => enumLabel(t, PRICEBOOK_METHODS, r.method),
    },
    {
      key: 'timing',
      header: t('pricebook.cols.timing'),
      cell: (r) => enumLabel(t, PRICEBOOK_TIMINGS, r.timing),
    },
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
    <>
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
        error={channels.isError}
        onRetry={() => void channels.refetch()}
        empty={t('channels.empty')}
        searchable
        actionsWidth="164px"
        selectable
        rowActions={(r) => (
          <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => {
                setEditing(r);
                setChOpen(true);
              }}
            />
            <RowAction
              icon={r.status === 'active' ? PauseIcon : PlayIcon}
              label={
                r.status === 'active' ? t('channels.actions.disable') : t('channels.actions.enable')
              }
              onClick={() => toggleStatus.mutate(r)}
            />
            <RowAction
              icon={ArrowsClockwiseIcon}
              label={t('channels.actions.syncModels')}
              loading={syncModels.isPending && syncModels.variables.id === r.id}
              onClick={() => syncModels.mutate(r)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('channels.actions.delete')}
              danger
              onClick={() => setDelTarget(r)}
            />
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
    </>
  );

  const pricingPanel = (
    <>
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
        error={pricebook.isError}
        onRetry={() => void pricebook.refetch()}
        empty={t('pricebook.empty')}
        searchable
        pageSize={10}
        actionsWidth="96px"
        rowActions={(r) => (
          <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
            <RowAction
              icon={r.active ? PauseIcon : PlayIcon}
              label={r.active ? t('pricebook.actions.disable') : t('pricebook.actions.enable')}
              loading={togglePbActive.isPending && togglePbActive.variables.id === r.id}
              onClick={() => togglePbActive.mutate(r)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setPbDelTarget(r)}
            />
          </div>
        )}
      />
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <Section title={t('resources.sections.overview')}>
        <QueryBoundary query={resources}>{overviewPanel}</QueryBoundary>
      </Section>
      <Section title={t('resources.sections.channels')}>{channelsPanel}</Section>
      <Section title={t('resources.sections.pricing')}>{pricingPanel}</Section>

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
      <ConfirmDialog
        open={pbDelTarget !== undefined}
        title={t('pricebook.delete.title')}
        message={t('pricebook.delete.message', {
          method: pbDelTarget ? enumLabel(t, PRICEBOOK_METHODS, pbDelTarget.method) : '',
          version: pbDelTarget?.version ?? '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deletePb.isPending}
        onConfirm={() => {
          if (pbDelTarget) deletePb.mutate(pbDelTarget);
        }}
        onClose={() => setPbDelTarget(undefined)}
      />
    </div>
  );
}

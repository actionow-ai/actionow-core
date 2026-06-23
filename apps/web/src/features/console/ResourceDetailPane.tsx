import {
  ArrowsClockwiseIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { ProviderIcon } from '../../components/data/ProviderIcon';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import {
  CHANNEL_STATUSES,
  enumLabel,
  MODALITIES,
  PRICEBOOK_METHODS,
  PRICEBOOK_TIMINGS,
  toOptions,
} from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelStatus, ChannelView, ModelView, PricebookView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';
import { ChannelCard } from './ChannelCard';
import { ChannelEditor } from './ChannelEditor';
import { ModelDetailDrawer } from './ModelDetailDrawer';
import { ModelEditor } from './ModelEditor';
import { ModelGrid } from './ModelGrid';
import { ModelsSection } from './ModelsSection';
import { PricingModal } from './PricingModal';

// Ordered to read as the supply pipeline 插件→通道→模型: a resource's channels
// (upstream routes) come first, the models they serve next, pricing last. The
// former 概览 tab is gone — its identity + status control now live in the header.
const DETAIL_TABS = ['channels', 'models', 'pricing'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

/** The right pane of the Resources master-detail: a header bar carrying the resource identity + status control, then a sub-tab strip (通道/模型/定价). Models nest here (catalog redesign). */
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

  const [dtab, setDtab] = useUrlState('dtab', 'channels');
  const dt: DetailTab = (DETAIL_TABS as readonly string[]).includes(dtab)
    ? (dtab as DetailTab)
    : 'channels';

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
    // allSettled so one failed channel doesn't abort the rest of the batch.
    mutationFn: async ({ rows, status }: { rows: ChannelView[]; status: ChannelStatus }) => {
      await Promise.allSettled(rows.map((c) => api.updateChannel(id, c.id, { status })));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      toast(t('channels.statusUpdated'));
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

  // --- Platform two-pane (catalog supply-hierarchy, kind='model') -----------
  // Selected channel lives in url-state (`?cid=`) so it's deep-linkable; defaults
  // to the first channel once they load.
  const [cid, setCid] = useUrlState('cid');
  const channelRows = channels.data ?? [];
  const selectedChannel =
    channelRows.find((c) => c.id === cid) ?? (cid === '' ? channelRows[0] : undefined);

  // Platform model catalog — the "link existing" picker + name resolution.
  const models = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
    enabled: id !== '',
  });
  const platformModels = (models.data ?? []).filter((m) => m.resource_id === id);
  const channelName = (channelId: string): string => {
    const c = channelRows.find((x) => x.id === channelId);
    return c ? c.provider_type : channelId.slice(0, 8);
  };

  const [modelTarget, setModelTarget] = useState<ModelView | undefined>(undefined);
  // The model being edited: a model name, the sentinel 'new' (create), or undefined (closed).
  const [modelEdit, setModelEdit] = useState<string | undefined>(undefined);
  const [linkOpen, setLinkOpen] = useState(false);

  const linkModel = useMutation({
    mutationFn: ({ channelId, modelId }: { channelId: string; modelId: string }) =>
      api.linkChannelModel(id, channelId, modelId),
    onSuccess: async (_r, { channelId }) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(channelId) });
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      toast(t('models.linked'));
    },
    onError: mutationError(t),
  });
  const unlinkModel = useMutation({
    mutationFn: ({ channelId, modelId }: { channelId: string; modelId: string }) =>
      api.unlinkChannelModel(id, channelId, modelId),
    onSuccess: async (_r, { channelId }) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(channelId) });
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      toast(t('models.unlinked'));
      setModelTarget(undefined);
    },
    onError: mutationError(t),
  });
  // Sync this channel's models then refresh its grid + the channel card count.
  const syncChannel = useMutation({
    mutationFn: (channelId: string) => api.syncChannelModels(id, channelId, {}),
    onSuccess: async (res, channelId) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(channelId) });
      await qc.invalidateQueries({ queryKey: qk.channels(id) });
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('channels.synced', { total: res.total }));
    },
    onError: mutationError(t),
  });

  const chCols: Column<ChannelView>[] = [
    {
      key: 'provider',
      header: t('channels.cols.provider'),
      width: '170px',
      noClip: true,
      cell: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
          <ProviderIcon provider={r.provider_type} size={18} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.provider_type}</span>
        </span>
      ),
    },
    // endpoint is the elastic column (long URLs); the rest are width-capped.
    { key: 'endpoint', header: t('channels.cols.endpoint'), grow: true, cell: (r) => r.endpoint ?? '—' },
    { key: 'model', header: t('channels.cols.model'), width: '150px', cell: (r) => r.model ?? '—' },
    {
      key: 'weight',
      header: t('channels.cols.weight'),
      cell: (r) => String(r.weight),
      width: '72px',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.weight,
    },
    {
      key: 'cost',
      header: t('channels.cols.cost'),
      sortable: true,
      numeric: true,
      noClip: true,
      // Sort by input cost (µUSD/1M); unset sorts as -1 so priced channels lead.
      sortValue: (r) => (r.input_cost_per_1m === null ? -1 : Number(r.input_cost_per_1m)),
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
      width: '130px',
    },
    {
      key: 'status',
      header: t('channels.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '100px',
    },
  ];

  const pbCols: Column<PricebookView>[] = [
    // method is the elastic column; the rest are width-capped.
    {
      key: 'method',
      header: t('pricebook.cols.method'),
      cell: (r) => enumLabel(t, PRICEBOOK_METHODS, r.method),
    },
    {
      key: 'timing',
      header: t('pricebook.cols.timing'),
      width: '150px',
      cell: (r) => enumLabel(t, PRICEBOOK_TIMINGS, r.timing),
    },
    {
      key: 'version',
      header: t('pricebook.cols.version'),
      width: '90px',
      numeric: true,
      cell: (r) => String(r.version),
    },
    {
      key: 'active',
      header: t('pricebook.cols.active'),
      width: '120px',
      noClip: true,
      cell: (r) => {
        const s = r.active ? 'active' : 'inactive';
        return <StatusBadge tone={statusTone(s)} label={t('status.' + s, s)} />;
      },
    },
  ];

  const channelsPanel = (
    <>
      <DataTable
        columns={chCols}
        rows={channels.data ?? []}
        rowKey={(r) => r.id}
        loading={channels.isLoading}
        error={channels.isError}
        onRetry={() => void channels.refetch()}
        empty={t('channels.empty')}
        searchable
        toolbarActions={
          <Button
            onClick={() => {
              setEditing(undefined);
              setChOpen(true);
            }}
          >
            <PlusIcon size={14} weight="bold" aria-hidden="true" />{' '}
            {t('resources.detail.addChannel')}
          </Button>
        }
        actionsWidth="160px"
        selectable
        rowActions={(r) => (
          <>
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
              loading={toggleStatus.isPending && toggleStatus.variables.id === r.id}
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
          </>
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
        toolbarActions={
          <Button onClick={() => setPbOpen(true)}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('resources.detail.addPrice')}
          </Button>
        }
        actionsWidth="96px"
        rowActions={(r) => (
          <>
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
          </>
        )}
      />
    </>
  );

  // A stale `?id` deep link (resource since deleted) resolves to no row once the
  // list has loaded — show a not-found state instead of a header with a bare id.
  if (!resources.isLoading && !resources.isError && resource === undefined) {
    return (
      <div
        className="panel"
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'var(--r-md)',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
          padding: 'var(--s-6)',
        }}
      >
        {t('resources.detail.notFound')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      {/* Header bar (former 概览 tab folded in): identity + meta + the status
          control, so there's no redundant overview tab restating the same row. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--s-3)',
          paddingBottom: 'var(--s-3)',
          borderBottom: '1px solid var(--row-bd)',
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
                {enumLabel(t, MODALITIES, resource.modality)} · {resource.provider_type} ·{' '}
                {resource.exec_modes.join(', ')}
              </span>
              <span style={{ color: 'var(--faint)' }}>v{resource.current_version}</span>
            </div>
          )}
        </div>
        {resource && (
          <div style={{ flexShrink: 0, minWidth: 150 }}>
            <SelectField
              label={t('resources.actions.setStatus')}
              value={resource.status === 'active' ? 'active' : 'disabled'}
              onChange={(v) => setResourceStatus.mutate(v as ChannelStatus)}
              options={toOptions(CHANNEL_STATUSES, t)}
            />
          </div>
        )}
      </div>

      {resource?.kind === 'model' ? (
        // Supply-hierarchy two-pane: channel cards (left) │ selected channel's
        // served-model grid (right). Models live on the channel; pricing is per
        // model (card + popup), so there's no standalone 定价 tab here.
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(230px, 0.4fr) minmax(0, 1fr)',
            gap: 'var(--s-4)',
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            <Button
              onClick={() => {
                setEditing(undefined);
                setChOpen(true);
              }}
            >
              <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('resources.detail.addChannel')}
            </Button>
            <QueryBoundary query={channels}>
              {channelRows.length === 0 ? (
                <div
                  className="panel"
                  style={{
                    borderRadius: 'var(--r-md)',
                    padding: 'var(--s-5)',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 'var(--fs-sm)',
                  }}
                >
                  {t('channels.empty')}
                </div>
              ) : (
                channelRows.map((c) => (
                  <ChannelCard
                    key={c.id}
                    channel={c}
                    selected={c.id === selectedChannel?.id}
                    onSelect={() => setCid(c.id)}
                    onEdit={() => {
                      setEditing(c);
                      setChOpen(true);
                    }}
                    onToggle={() => toggleStatus.mutate(c)}
                    onSync={() => syncChannel.mutate(c.id)}
                    onDelete={() => setDelTarget(c)}
                    toggling={toggleStatus.isPending && toggleStatus.variables.id === c.id}
                    syncing={syncChannel.isPending && syncChannel.variables === c.id}
                  />
                ))
              )}
            </QueryBoundary>
          </div>

          {selectedChannel !== undefined ? (
            <ModelGrid
              resourceId={id}
              channel={selectedChannel}
              onSync={() => syncChannel.mutate(selectedChannel.id)}
              onAddModel={() => setLinkOpen(true)}
              onSelectModel={setModelTarget}
              syncing={syncChannel.isPending && syncChannel.variables === selectedChannel.id}
            />
          ) : (
            <div
              className="panel"
              style={{
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-6)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--muted)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {t('resources.detail.pickChannel')}
            </div>
          )}
        </div>
      ) : (
        <>
          <SegmentedControl
            ariaLabel={t('resources.detail.tabsLabel')}
            value={dt}
            onChange={setDtab}
            options={DETAIL_TABS.map((tb) => ({ value: tb, label: t(`resources.sections.${tb}`) }))}
          />
          {dt === 'channels' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>{channelsPanel}</div>
          )}
          {dt === 'pricing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>{pricingPanel}</div>
          )}
          {dt === 'models' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
              <ModelsSection resourceId={id} />
            </div>
          )}
        </>
      )}

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

      {modelTarget !== undefined && selectedChannel !== undefined && (
        <ModelDetailDrawer
          model={modelTarget}
          channelLabel={selectedChannel.provider_type}
          servedChannelLabels={modelTarget.served_channel_ids.map(channelName)}
          unlinking={unlinkModel.isPending}
          onEdit={() => {
            setModelEdit(modelTarget.name);
            setModelTarget(undefined);
          }}
          onUnlink={() =>
            unlinkModel.mutate({ channelId: selectedChannel.id, modelId: modelTarget.id })
          }
          onClose={() => setModelTarget(undefined)}
        />
      )}

      {modelEdit !== undefined && (
        <ModelEditor
          key={modelEdit}
          name={modelEdit === 'new' ? undefined : modelEdit}
          open
          fixedResourceId={id}
          onClose={() => setModelEdit(undefined)}
        />
      )}

      {linkOpen && selectedChannel !== undefined && (
        <Modal
          open
          title={t('models.linkTitle', { channel: selectedChannel.provider_type })}
          onClose={() => setLinkOpen(false)}
          footer={
            <Button variant="ghost" onClick={() => setModelEdit('new')}>
              <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.new')}
            </Button>
          }
        >
          <QueryBoundary query={models}>
            {(() => {
              const linked = new Set(
                (qc.getQueryData<ModelView[]>(qk.channelModels(selectedChannel.id)) ?? []).map(
                  (m) => m.id,
                ),
              );
              const candidates = platformModels.filter((m) => !linked.has(m.id));
              if (candidates.length === 0) {
                return (
                  <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                    {t('models.allLinked')}
                  </p>
                );
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                  {candidates.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="entity-card is-clickable"
                      style={{ textAlign: 'left', padding: 'var(--s-3) var(--s-4)', cursor: 'pointer' }}
                      onClick={() => {
                        linkModel.mutate(
                          { channelId: selectedChannel.id, modelId: m.id },
                          { onSuccess: () => setLinkOpen(false) },
                        );
                      }}
                    >
                      <span style={{ fontWeight: 'var(--fw-medium)' }}>{m.name}</span>
                      <span style={{ color: 'var(--muted)' }}>
                        {' '}
                        · {enumLabel(t, MODALITIES, m.modality)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })()}
          </QueryBoundary>
        </Modal>
      )}
    </div>
  );
}

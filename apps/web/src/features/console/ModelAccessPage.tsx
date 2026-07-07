import { featuresToCapabilities } from '@actionow/contracts';
import {
  ArrowsClockwiseIcon,
  BuildingsIcon,
  CaretDownIcon,
  CaretRightIcon,
  LinkBreakIcon,
  PencilSimpleIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BrandIcon } from '../../components/data/BrandIcon';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FilterMenu } from '../../components/ui/FilterMenu';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, ModelView, ProviderPluginView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { ChannelCard } from './ChannelCard';
import { ChannelEditor } from './ChannelEditor';
import { ModelEditor } from './ModelEditor';
import { ParamOverrideEditor } from './ParamOverrideEditor';
import { PluginEditor } from './PluginEditor';
import { type FacetDef, useFacets } from './useFacets';

/** Format an integer µUSD-per-1M string as a compact `$X` price (mirrors ModelGrid). */
function usd(micro: string): string {
  const n = Number(micro) / 1_000_000;
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * 模型接入 — a MASTER-DETAIL management surface (方案 A). LEFT: a narrow SUPPLY
 * TREE that folds 插件 + 通道 into one accordion (a plugin row expands to its
 * channels), freeing horizontal space. RIGHT: the selected channel's models as a
 * dense, paginated DataTable (was a low-density card list). Platform stays in the
 * DB for routing but is hidden; pricing is per-model (model editor). No global
 * styles change — the split is a local grid; rows reuse `.entity-card`/`.chip`.
 */
export function ModelAccessPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const narrow = useMediaQuery('(max-width: 900px)');

  // 平台与定价 is a contextual surface reachable only from here (nav-config keeps
  // it hidden) — this TopBar link is the entry the nav comment promises.
  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => void navigate('/console/platforms')}>
        <BuildingsIcon size={14} weight="bold" aria-hidden="true" /> {t('nav.platforms')}
      </Button>
    ),
    [t],
  );
  // `plugin` + `cid` live in one URL so a plugin switch sets the plugin AND clears
  // the channel in a single navigate (two setters would clobber each other).
  const [params, setParams] = useSearchParams();
  const pluginId = params.get('plugin') ?? '';
  const cid = params.get('cid') ?? '';
  // A plugin row toggles: selecting a different plugin expands it (and clears the
  // channel); re-selecting the already-expanded plugin (`collapse`) folds the tree
  // shut via the NO_PLUGIN sentinel, so the accordion can actually close — not just
  // switch. Callers pass `active` so we compare against the *expanded* plugin
  // (which, on first paint, is the auto-selected first row whose id ≠ '').
  const selectPlugin = (id: string, collapse: boolean): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('plugin', collapse ? NO_PLUGIN : id);
        next.delete('cid');
        return next;
      },
      { replace: true },
    );
  const setCid = (id: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === '') next.delete('cid');
        else next.set('cid', id);
        return next;
      },
      { replace: true },
    );

  const [pluginQ, setPluginQ] = useState('');
  const [modelQ, setModelQ] = useState('');

  const plugins = useQuery({
    queryKey: qk.plugins(),
    queryFn: () => api.listPlugins(),
    staleTime: STALE_REFERENCE,
  });
  const pluginRows = plugins.data ?? [];
  const pluginFacets = useFacets(pluginRows, pluginFacetDefs(t));
  const pq = pluginQ.trim().toLowerCase();
  // Default order: most models first (then most channels), label as the tiebreak.
  const filteredPlugins = pluginRows
    .filter(
      (p) =>
        (pq === '' || `${p.label} ${p.slug}`.toLowerCase().includes(pq)) && pluginFacets.match(p),
    )
    .sort(
      (a, b) =>
        b.model_count - a.model_count ||
        b.channel_count - a.channel_count ||
        a.label.localeCompare(b.label),
    );
  const selectedPlugin =
    pluginId === NO_PLUGIN
      ? undefined
      : (pluginRows.find((p) => p.id === pluginId) ??
        (pluginId === '' ? filteredPlugins[0] : undefined));

  const channels = useQuery({
    queryKey: qk.pluginChannels(selectedPlugin?.id ?? ''),
    queryFn: () => api.listPluginChannels(selectedPlugin?.id ?? ''),
    enabled: selectedPlugin !== undefined,
  });
  const channelRows = channels.data ?? [];
  // The expanded plugin's channels, most-models first (channels are few → no filter/facet UI).
  const treeChannels = channelRows.slice().sort((a, b) => b.model_count - a.model_count);
  const selectedChannel =
    channelRows.find((c) => c.id === cid) ?? (cid === '' ? treeChannels[0] : undefined);

  // The selected channel's models — drives the right-pane table + its facets.
  const channelModels = useQuery({
    queryKey: qk.channelModels(selectedChannel?.id ?? ''),
    queryFn: () =>
      api.listChannelModels(selectedChannel?.resource_id ?? '', selectedChannel?.id ?? ''),
    enabled: selectedChannel !== undefined,
  });
  const modelFacets = useFacets(channelModels.data ?? [], modelFacetDefs(t));
  const mq = modelQ.trim().toLowerCase();
  const modelRows = (channelModels.data ?? []).filter(
    (m) => (mq === '' || m.name.toLowerCase().includes(mq)) && modelFacets.match(m),
  );

  const [pluginEdit, setPluginEdit] = useState<ProviderPluginView | 'new' | null>(null);
  const [pluginDelTarget, setPluginDelTarget] = useState<ProviderPluginView | undefined>(undefined);
  const [channelEdit, setChannelEdit] = useState<ChannelView | 'new' | null>(null);
  const [chDelTarget, setChDelTarget] = useState<ChannelView | undefined>(undefined);
  const [modelEdit, setModelEdit] = useState<{ name?: string; resourceId: string } | null>(null);
  // Link-existing-models picker for the selected channel (真关联,非新建).
  const [linkOpen, setLinkOpen] = useState(false);
  // Per-(model×channel) param override editor target (模型参数绑定 Phase 0).
  const [overrideEdit, setOverrideEdit] = useState<ModelView | null>(null);

  // The platform's model catalog — candidates for the link picker (only loaded
  // once the picker is relevant; a channel must be selected).
  const allModels = useQuery({
    queryKey: qk.models(),
    queryFn: () => api.listModels(),
    staleTime: STALE_REFERENCE,
    enabled: selectedChannel !== undefined,
  });

  const invalidateChannels = async (): Promise<void> => {
    if (selectedPlugin !== undefined)
      await qc.invalidateQueries({ queryKey: qk.pluginChannels(selectedPlugin.id) });
  };

  const toggleChannel = useMutation({
    mutationFn: (c: ChannelView) =>
      api.updateChannel(c.resource_id, c.id, {
        status: c.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: invalidateChannels,
    onError: mutationError(t),
  });
  const deleteChannel = useMutation({
    mutationFn: (c: ChannelView) => api.deleteChannel(c.resource_id, c.id),
    onSuccess: async () => {
      await invalidateChannels();
      toast(t('channels.deleted'));
      setChDelTarget(undefined);
    },
    onError: mutationError(t),
  });
  const syncChannel = useMutation({
    mutationFn: (c: ChannelView) => api.syncChannelModels(c.resource_id, c.id, {}),
    onSuccess: async (res, c) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(c.id) });
      await invalidateChannels();
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('channels.synced', { total: res.total }));
    },
    onError: mutationError(t),
  });
  const deletePlugin = useMutation({
    mutationFn: (p: ProviderPluginView) => api.deletePlugin(p.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.plugins() });
      toast(t('plugins.deleted'));
      setPluginDelTarget(undefined);
    },
    onError: mutationError(t),
  });
  const linkModel = useMutation({
    mutationFn: ({ channel, modelId }: { channel: ChannelView; modelId: string }) =>
      api.linkChannelModel(channel.resource_id, channel.id, modelId),
    onSuccess: async (_r, { channel }) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(channel.id) });
      await invalidateChannels();
      toast(t('models.linked'));
    },
    onError: mutationError(t),
  });
  const unlinkModel = useMutation({
    mutationFn: ({ channel, modelId }: { channel: ChannelView; modelId: string }) =>
      api.unlinkChannelModel(channel.resource_id, channel.id, modelId),
    onSuccess: async (_r, { channel }) => {
      await qc.invalidateQueries({ queryKey: qk.channelModels(channel.id) });
      await invalidateChannels();
      toast(t('models.unlinked'));
    },
    onError: mutationError(t),
  });

  const modelCols: Column<ModelView>[] = [
    {
      key: 'name',
      header: t('modelAccess.cols.model'),
      grow: true,
      cell: (m) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
          <BrandIcon
            icon={m.icon}
            fallbacks={[selectedChannel?.icon, selectedChannel?.provider_type, m.maker, m.modality]}
            size={16}
          />
          <span
            style={{
              fontWeight: 'var(--fw-medium)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.name}
          </span>
          <CustomizationBadges model={m} t={t} />
        </div>
      ),
    },
    {
      key: 'modality',
      header: t('facets.modality'),
      width: '96px',
      cell: (m) => (
        <span style={{ color: 'var(--muted)' }}>{enumLabel(t, MODALITIES, m.modality)}</span>
      ),
    },
    {
      key: 'caps',
      header: t('modelAccess.cols.caps'),
      width: '176px',
      cell: (m) => <CapChips caps={capsForDisplay(m)} />,
    },
    {
      key: 'price',
      header: t('modelAccess.cols.price'),
      align: 'right',
      width: '132px',
      cell: (m) => {
        const priced = m.input_price !== '0' || m.output_price !== '0';
        return priced ? (
          <span className="tabular">
            {usd(m.input_price)} / {usd(m.output_price)}
          </span>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        );
      },
    },
    {
      key: 'status',
      header: t('channels.form.status'),
      align: 'right',
      width: '92px',
      cell: (m) => (
        <StatusBadge tone={statusTone(m.status)} label={t('status.' + m.status, m.status)} />
      ),
    },
  ];

  return (
    <div style={narrow ? SPLIT_NARROW : SPLIT_WIDE}>
      {/* ── Left: supply tree (插件 ▸ 通道) ──────────────────────────────── */}
      <div style={narrow ? COL_NARROW : COL}>
        <ColumnHead
          title={t('modelAccess.supply')}
          count={pluginRows.length}
          search={pluginQ}
          onSearch={setPluginQ}
          searchPlaceholder={t('modelAccess.searchPlugins')}
          filter={
            <FilterMenu
              groups={pluginFacets.groups}
              selected={pluginFacets.selected}
              onToggle={pluginFacets.toggle}
              onClear={pluginFacets.clear}
              activeCount={pluginFacets.activeCount}
            />
          }
          action={
            <Button variant="ghost" size="sm" onClick={() => setPluginEdit('new')}>
              <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('plugins.new')}
            </Button>
          }
        />
        <div style={LIST}>
          <QueryBoundary query={plugins}>
            {filteredPlugins.map((p) => {
              const active = p.id === selectedPlugin?.id;
              return (
                <div
                  key={p.id}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}
                >
                  <div
                    className={`entity-card is-clickable${active ? ' is-selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    aria-expanded={active}
                    onClick={() => selectPlugin(p.id, active)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectPlugin(p.id, active);
                      }
                    }}
                    style={{ padding: 'var(--s-2) var(--s-3)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--s-2)',
                        minWidth: 0,
                      }}
                    >
                      {active ? (
                        <CaretDownIcon size={12} weight="bold" aria-hidden="true" />
                      ) : (
                        <CaretRightIcon size={12} weight="bold" aria-hidden="true" />
                      )}
                      <BrandIcon icon={p.icon} fallbacks={[p.slug]} size={18} />
                      <span
                        style={{
                          fontWeight: 'var(--fw-medium)',
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.label}
                      </span>
                      <span
                        className="chip"
                        title={`${t('modelAccess.channelsN', { n: p.channel_count })} · ${t('resources.cards.modelsN', { n: p.model_count })}`}
                      >
                        {p.channel_count} · {p.model_count}
                      </span>
                      <span
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="presentation"
                        style={{ display: 'inline-flex', gap: 'var(--s-1)' }}
                      >
                        <RowAction
                          icon={PencilSimpleIcon}
                          label={t('common.edit')}
                          onClick={() => setPluginEdit(p)}
                        />
                        <RowAction
                          icon={TrashIcon}
                          label={t('common.delete')}
                          danger
                          disabled={p.builtin}
                          onClick={() => setPluginDelTarget(p)}
                        />
                      </span>
                    </div>
                  </div>
                  {active && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--s-2)',
                        paddingLeft: 'var(--s-4)',
                      }}
                    >
                      <QueryBoundary query={channels}>
                        {treeChannels.length === 0 ? (
                          <Placeholder text={t('modelAccess.noChannels')} inset />
                        ) : (
                          treeChannels.map((c) => (
                            <ChannelCard
                              key={c.id}
                              channel={c}
                              selected={c.id === selectedChannel?.id}
                              onSelect={() => setCid(c.id)}
                              onEdit={() => setChannelEdit(c)}
                              onToggle={() => toggleChannel.mutate(c)}
                              onSync={() => syncChannel.mutate(c)}
                              onDelete={() => setChDelTarget(c)}
                              toggling={
                                toggleChannel.isPending && toggleChannel.variables.id === c.id
                              }
                              syncing={syncChannel.isPending && syncChannel.variables.id === c.id}
                            />
                          ))
                        )}
                      </QueryBoundary>
                      <div style={{ alignSelf: 'flex-start' }}>
                        <Button variant="ghost" size="sm" onClick={() => setChannelEdit('new')}>
                          <PlusIcon size={14} weight="bold" aria-hidden="true" />{' '}
                          {t('modelAccess.addChannel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </QueryBoundary>
        </div>
      </div>

      {/* ── Right: the selected channel's models (dense table) ───────────── */}
      <div style={narrow ? COL_NARROW : COL}>
        {selectedChannel === undefined ? (
          <Placeholder text={t('modelAccess.pickChannel')} />
        ) : (
          <>
            <ColumnHead
              title={`${t('modelAccess.models')} · ${selectedChannel.provider_type}`}
              count={modelRows.length}
              search={modelQ}
              onSearch={setModelQ}
              searchPlaceholder={t('modelAccess.searchModels')}
              filter={
                <FilterMenu
                  groups={modelFacets.groups}
                  selected={modelFacets.selected}
                  onToggle={modelFacets.toggle}
                  onClear={modelFacets.clear}
                  activeCount={modelFacets.activeCount}
                />
              }
              action={
                <>
                  {/* async-media (media relay) can't auto-discover models → no sync. */}
                  {selectedChannel.provider_type !== 'async-media' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => syncChannel.mutate(selectedChannel)}
                      loading={
                        syncChannel.isPending && syncChannel.variables.id === selectedChannel.id
                      }
                    >
                      <ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" />{' '}
                      {t('channels.actions.syncModels')}
                    </Button>
                  )}
                  {/* 真·关联: pick EXISTING platform models to link — creating a
                      brand-new model lives inside the picker's footer. */}
                  <Button variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>
                    <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.link')}
                  </Button>
                </>
              }
            />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 var(--s-2)' }}>
              <DataTable
                columns={modelCols}
                rows={modelRows}
                rowKey={(m) => m.id}
                loading={channelModels.isLoading}
                error={channelModels.isError}
                onRetry={() => void channelModels.refetch()}
                empty={t('modelAccess.noModels')}
                onRowClick={(m) =>
                  setModelEdit({ name: m.name, resourceId: selectedChannel.resource_id })
                }
                actionsWidth="132px"
                rowActions={(m) => (
                  <>
                    <RowAction
                      icon={SlidersHorizontalIcon}
                      label={hasOverride(m) ? t('override.active') : t('override.edit')}
                      onClick={() => setOverrideEdit(m)}
                    />
                    <RowAction
                      icon={PencilSimpleIcon}
                      label={t('common.edit')}
                      onClick={() =>
                        setModelEdit({ name: m.name, resourceId: selectedChannel.resource_id })
                      }
                    />
                    <RowAction
                      icon={LinkBreakIcon}
                      label={t('models.unlink')}
                      danger
                      onClick={() =>
                        unlinkModel.mutate({ channel: selectedChannel, modelId: m.id })
                      }
                    />
                  </>
                )}
                pageSize={30}
                fill
              />
            </div>
          </>
        )}
      </div>

      {pluginEdit !== null && (
        <PluginEditor
          key={pluginEdit === 'new' ? 'new' : pluginEdit.id}
          plugin={pluginEdit === 'new' ? undefined : pluginEdit}
          onClose={() => setPluginEdit(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: qk.plugins() });
            setPluginEdit(null);
          }}
        />
      )}

      {channelEdit !== null && selectedPlugin !== undefined && (
        <ChannelEditor
          key={channelEdit === 'new' ? 'new' : channelEdit.id}
          channel={channelEdit === 'new' ? undefined : channelEdit}
          presetPluginId={selectedPlugin.id}
          open
          onClose={() => setChannelEdit(null)}
        />
      )}

      {modelEdit !== null && (
        <ModelEditor
          key={modelEdit.name ?? 'new'}
          name={modelEdit.name}
          fixedResourceId={modelEdit.name === undefined ? modelEdit.resourceId : undefined}
          open
          onClose={() => {
            setModelEdit(null);
            if (selectedChannel !== undefined)
              void qc.invalidateQueries({ queryKey: qk.channelModels(selectedChannel.id) });
          }}
        />
      )}

      {overrideEdit !== null && selectedChannel !== undefined && (
        <ParamOverrideEditor
          key={overrideEdit.id}
          resourceId={selectedChannel.resource_id}
          channelId={selectedChannel.id}
          modelId={overrideEdit.id}
          modelName={overrideEdit.name}
          onClose={() => setOverrideEdit(null)}
        />
      )}

      <ConfirmDialog
        open={chDelTarget !== undefined}
        title={t('confirm.deleteChannelTitle')}
        message={t('confirm.deleteChannelMsg', { provider: chDelTarget?.provider_type ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deleteChannel.isPending}
        onConfirm={() => {
          if (chDelTarget !== undefined) deleteChannel.mutate(chDelTarget);
        }}
        onClose={() => setChDelTarget(undefined)}
      />

      <ConfirmDialog
        open={pluginDelTarget !== undefined}
        title={t('plugins.delete.title')}
        message={t('plugins.delete.message', { name: pluginDelTarget?.label ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deletePlugin.isPending}
        onConfirm={() => {
          if (pluginDelTarget !== undefined) deletePlugin.mutate(pluginDelTarget);
        }}
        onClose={() => setPluginDelTarget(undefined)}
      />

      {/* Link-existing picker: the platform models not yet on this channel. */}
      {linkOpen && selectedChannel !== undefined && (
        <Modal
          open
          title={t('models.linkTitle', { channel: selectedChannel.provider_type })}
          onClose={() => setLinkOpen(false)}
          footer={
            <Button
              variant="ghost"
              onClick={() => {
                setLinkOpen(false);
                setModelEdit({ resourceId: selectedChannel.resource_id });
              }}
            >
              <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.new')}
            </Button>
          }
        >
          <QueryBoundary query={allModels}>
            {(() => {
              const linked = new Set((channelModels.data ?? []).map((m) => m.id));
              const candidates = (allModels.data ?? []).filter(
                (m) => m.resource_id === selectedChannel.resource_id && !linked.has(m.id),
              );
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
                      style={{
                        textAlign: 'left',
                        padding: 'var(--s-3) var(--s-4)',
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        linkModel.mutate(
                          { channel: selectedChannel, modelId: m.id },
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

/** True when a (model,channel) link carries a non-empty param override (mig 0062). */
function hasOverride(m: ModelView): boolean {
  return m.param_override !== null && m.param_override.ops.length > 0;
}

/**
 * The capabilities to DISPLAY: the gate projection of the model's `features`
 * (Option C — what `normalizeRequest` actually enforces) when the profile carries
 * any, else the stored coarse `capabilities` map (a legacy row not yet re-synced).
 * Keeps the list's caps column consistent with the model editor + the gate.
 */
function capsForDisplay(m: ModelView): Record<string, boolean> {
  return m.param_profile.features.length > 0
    ? featuresToCapabilities(m.param_profile.features)
    : m.capabilities;
}

/**
 * True when the model carries CURATED parameter rules (min/max/default). Features
 * now flow from the catalog onto almost every model (Option C), so the 「档案」
 * badge keys on `parameterRules` — the genuinely operator-/spec-tuned part — to
 * stay a meaningful "this model is customized" signal rather than lighting up
 * everywhere.
 */
function hasProfile(m: ModelView): boolean {
  return m.param_profile.parameterRules.length > 0;
}

/**
 * At-a-glance customization markers (模型参数绑定 Phase 2): a compact 「覆盖」 chip
 * when this (model, selected-channel) has a `param_override`, and a 「档案」 chip
 * when the model carries a non-empty `param_profile` — so an operator sees which
 * models are customized on the channel without opening the editor. Both absent →
 * nothing renders (the common case). Reuses the shared `.chip` primitive; no new
 * styles.
 */
function CustomizationBadges({ model, t }: { model: ModelView; t: TFunction }) {
  const override = hasOverride(model);
  const profile = hasProfile(model);
  if (!override && !profile) return null;
  return (
    <div style={{ display: 'flex', gap: 'var(--s-1)', flexShrink: 0 }}>
      {override && (
        <span
          className="chip"
          style={{ fontSize: 'var(--fs-caption)', color: 'var(--accent)' }}
          title={t('modelAccess.badge.overrideTip')}
        >
          {t('modelAccess.badge.override')}
        </span>
      )}
      {profile && (
        <span
          className="chip"
          style={{ fontSize: 'var(--fs-caption)' }}
          title={t('modelAccess.badge.profileTip')}
        >
          {t('modelAccess.badge.profile')}
        </span>
      )}
    </div>
  );
}

/** Enabled capability keys as compact chips (bounded; the rest folded into `+N`). */
function CapChips({ caps }: { caps: Record<string, boolean> }) {
  const on = Object.entries(caps)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (on.length === 0) return <span style={{ color: 'var(--faint)' }}>—</span>;
  const shown = on.slice(0, 3);
  return (
    <div style={{ display: 'flex', gap: 'var(--s-1)', flexWrap: 'nowrap', overflow: 'hidden' }}>
      {shown.map((k) => (
        <span key={k} className="chip" style={{ fontSize: 'var(--fs-caption)' }}>
          {k}
        </span>
      ))}
      {on.length > shown.length && (
        <span className="chip" style={{ fontSize: 'var(--fs-caption)' }}>
          +{on.length - shown.length}
        </span>
      )}
    </div>
  );
}

/** A pane's header: title · count · action, then a search box + a filter popover. */
function ColumnHead({
  title,
  count,
  search,
  onSearch,
  searchPlaceholder,
  filter,
  action,
}: {
  title: string;
  count?: number;
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  filter: ReactNode;
  action: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
        padding: '0 var(--s-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
        <span
          style={{
            fontSize: 'var(--fs-sm)',
            fontWeight: 'var(--fw-semibold)',
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        {count !== undefined && <span className="chip">{count}</span>}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {filter}
      </div>
    </div>
  );
}

function Placeholder({ text, inset }: { text: string; inset?: boolean }) {
  return (
    <div
      className="panel"
      style={{
        height: inset === true ? 'auto' : '100%',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-md)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
        padding: 'var(--s-6)',
        margin: inset === true ? 'var(--s-1) var(--s-2)' : 0,
      }}
    >
      {text}
    </div>
  );
}

// --- per-column filter dimensions (useFacets) ------------------------------
function pluginFacetDefs(t: TFunction): FacetDef<ProviderPluginView>[] {
  return [
    {
      key: 'modality',
      title: t('facets.modality'),
      values: (p) => p.modalities,
      label: (v) => enumLabel(t, MODALITIES, v),
    },
    { key: 'protocol', title: t('plugins.cols.protocol'), values: (p) => [p.protocol] },
    { key: 'auth', title: t('plugins.cols.auth'), values: (p) => [p.auth_strategy] },
    {
      key: 'kind',
      title: t('plugins.cols.kind'),
      values: (p) => [p.builtin ? 'builtin' : 'custom'],
      label: (v) => t(v === 'builtin' ? 'plugins.builtin' : 'plugins.custom'),
    },
    {
      key: 'status',
      title: t('plugins.cols.status'),
      values: (p) => [p.status],
      label: (v) => t('status.' + v, v),
    },
  ];
}
function modelFacetDefs(t: TFunction): FacetDef<ModelView>[] {
  return [
    {
      key: 'status',
      title: t('channels.form.status'),
      values: (m) => [m.status],
      label: (v) => t('status.' + v, v),
    },
    {
      key: 'modality',
      title: t('facets.modality'),
      values: (m) => [m.modality],
      label: (v) => enumLabel(t, MODALITIES, v),
    },
    { key: 'maker', title: t('facets.maker'), values: (m) => (m.maker !== null ? [m.maker] : []) },
    { key: 'tag', title: t('facets.tag'), values: (m) => m.tags },
  ];
}

// Sentinel `plugin` URL value meaning "explicitly collapsed" (no plugin expanded)
// — distinct from an empty param, which auto-selects the first plugin. A real
// plugin id is a UUID, so '-' can never collide with one.
const NO_PLUGIN = '-';

// Master-detail split (供给树 │ 模型表). A LOCAL grid — no global `.tri-pane`. On a
// narrow viewport the two panes stack (each capped so both stay reachable).
const SPLIT_WIDE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 360px) minmax(0, 1fr)',
  gap: 'var(--s-3)',
  height: '100%',
  minHeight: 0,
};
const SPLIT_NARROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3)',
  minHeight: 0,
};
const COL: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};
const COL_NARROW: CSSProperties = {
  maxHeight: '60vh',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};
// The scrolling list: horizontal breathing room so a card's hover-lift shadow +
// `is-selected` ring (a 1px box-shadow) are never clipped at the pane edges.
const LIST: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
  padding: 'var(--s-1) var(--s-2) var(--s-4)',
};

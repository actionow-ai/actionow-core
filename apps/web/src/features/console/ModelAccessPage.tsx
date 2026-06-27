import { ArrowsClockwiseIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { BrandIcon } from '../../components/data/BrandIcon';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FilterMenu } from '../../components/ui/FilterMenu';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, ModelView, ProviderPluginView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { ChannelCard } from './ChannelCard';
import { ChannelEditor } from './ChannelEditor';
import { ModelEditor } from './ModelEditor';
import { ModelGrid } from './ModelGrid';
import { PluginEditor } from './PluginsPage';
import { type FacetDef, useFacets } from './useFacets';

/**
 * 模型接入 — the single 3-pane management surface. Three EQUAL columns, each with
 * its own header (title · search · filter · add): 插件 → 通道 (bound to the selected
 * plugin, across resources) → 模型 (the selected channel's served models, as a
 * list). Platform stays in the DB for routing but is hidden; pricing is per-model
 * (model editor), so there is no platform/pricing entry here.
 */
export function ModelAccessPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  // `plugin` + `cid` live in one URL so a plugin switch sets the plugin AND clears
  // the channel in a single navigate (two setters would clobber each other).
  const [params, setParams] = useSearchParams();
  const pluginId = params.get('plugin') ?? '';
  const cid = params.get('cid') ?? '';
  const selectPlugin = (id: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('plugin', id);
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

  // Per-column free-text search (the multi-dimension filters are FilterMenu/useFacets).
  const [pluginQ, setPluginQ] = useState('');
  const [channelQ, setChannelQ] = useState('');
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
  // Default selection follows the sorted view (the top card), not slug order.
  const selectedPlugin =
    pluginRows.find((p) => p.id === pluginId) ?? (pluginId === '' ? filteredPlugins[0] : undefined);

  const channels = useQuery({
    queryKey: qk.pluginChannels(selectedPlugin?.id ?? ''),
    queryFn: () => api.listPluginChannels(selectedPlugin?.id ?? ''),
    enabled: selectedPlugin !== undefined,
  });
  const channelRows = channels.data ?? [];
  const channelFacets = useFacets(channelRows, channelFacetDefs(t));
  const cq = channelQ.trim().toLowerCase();
  // Default order: most models first.
  const filteredChannels = channelRows
    .filter(
      (c) =>
        (cq === '' || `${c.provider_type} ${c.endpoint ?? ''}`.toLowerCase().includes(cq)) &&
        channelFacets.match(c),
    )
    .sort((a, b) => b.model_count - a.model_count);
  const selectedChannel =
    channelRows.find((c) => c.id === cid) ?? (cid === '' ? filteredChannels[0] : undefined);

  // The selected channel's models — fetched here (deduped with ModelGrid's same
  // query key) so the column header can build model facets; the list filters by
  // the resulting `match` + the model search box.
  const channelModels = useQuery({
    queryKey: qk.channelModels(selectedChannel?.id ?? ''),
    queryFn: () =>
      api.listChannelModels(selectedChannel?.resource_id ?? '', selectedChannel?.id ?? ''),
    enabled: selectedChannel !== undefined,
  });
  const modelFacets = useFacets(channelModels.data ?? [], modelFacetDefs(t));

  const [pluginEdit, setPluginEdit] = useState<ProviderPluginView | 'new' | null>(null);
  const [channelEdit, setChannelEdit] = useState<ChannelView | 'new' | null>(null);
  const [chDelTarget, setChDelTarget] = useState<ChannelView | undefined>(undefined);
  const [modelEdit, setModelEdit] = useState<{ name?: string; resourceId: string } | null>(null);

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

  return (
    <div className="tri-pane">
      {/* ── Column 1: plugin library ─────────────────────────────────────── */}
      <div style={COL}>
        <ColumnHead
          title={t('modelAccess.plugins')}
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
                  className={`entity-card is-clickable${active ? ' is-selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => selectPlugin(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectPlugin(p.id);
                    }
                  }}
                  style={{ padding: 'var(--s-3) var(--s-4)' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--s-2)',
                      minWidth: 0,
                    }}
                  >
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
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      role="presentation"
                    >
                      <RowAction
                        icon={PencilSimpleIcon}
                        label={t('common.edit')}
                        onClick={() => setPluginEdit(p)}
                      />
                    </span>
                  </div>
                  <div
                    style={{ display: 'flex', gap: 'var(--s-1)', marginTop: 6, flexWrap: 'wrap' }}
                  >
                    <span className="chip">
                      {t('modelAccess.channelsN', { n: p.channel_count })}
                    </span>
                    <span className="chip">
                      {t('resources.cards.modelsN', { n: p.model_count })}
                    </span>
                    <span className="chip">
                      {p.builtin ? t('plugins.builtin') : t('plugins.custom')}
                    </span>
                  </div>
                </div>
              );
            })}
          </QueryBoundary>
        </div>
      </div>

      {/* ── Column 2: channels of the selected plugin ────────────────────── */}
      <div style={COL}>
        {selectedPlugin === undefined ? (
          <Placeholder text={t('modelAccess.pickPlugin')} />
        ) : (
          <>
            <ColumnHead
              title={`${t('modelAccess.channels')} · ${selectedPlugin.label}`}
              count={channelRows.length}
              search={channelQ}
              onSearch={setChannelQ}
              searchPlaceholder={t('modelAccess.searchChannels')}
              filter={
                <FilterMenu
                  groups={channelFacets.groups}
                  selected={channelFacets.selected}
                  onToggle={channelFacets.toggle}
                  onClear={channelFacets.clear}
                  activeCount={channelFacets.activeCount}
                />
              }
              action={
                <Button variant="ghost" size="sm" onClick={() => setChannelEdit('new')}>
                  <PlusIcon size={14} weight="bold" aria-hidden="true" />{' '}
                  {t('modelAccess.addChannel')}
                </Button>
              }
            />
            <div style={LIST}>
              <QueryBoundary query={channels}>
                {filteredChannels.length === 0 ? (
                  <Placeholder text={t('modelAccess.noChannels')} inset />
                ) : (
                  filteredChannels.map((c) => (
                    <ChannelCard
                      key={c.id}
                      channel={c}
                      selected={c.id === selectedChannel?.id}
                      onSelect={() => setCid(c.id)}
                      onEdit={() => setChannelEdit(c)}
                      onToggle={() => toggleChannel.mutate(c)}
                      onSync={() => syncChannel.mutate(c)}
                      onDelete={() => setChDelTarget(c)}
                      toggling={toggleChannel.isPending && toggleChannel.variables.id === c.id}
                      syncing={syncChannel.isPending && syncChannel.variables.id === c.id}
                    />
                  ))
                )}
              </QueryBoundary>
            </div>
          </>
        )}
      </div>

      {/* ── Column 3: the selected channel's models (list) ───────────────── */}
      <div style={COL}>
        {selectedChannel === undefined ? (
          <Placeholder text={t('modelAccess.pickChannel')} />
        ) : (
          <>
            <ColumnHead
              title={`${t('modelAccess.models')} · ${selectedChannel.provider_type}`}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setModelEdit({ resourceId: selectedChannel.resource_id })}
                  >
                    <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.link')}
                  </Button>
                </>
              }
            />
            <div style={LIST}>
              <ModelGrid
                resourceId={selectedChannel.resource_id}
                channel={selectedChannel}
                variant="list"
                showHeader={false}
                search={modelQ}
                match={modelFacets.match}
                onSync={() => syncChannel.mutate(selectedChannel)}
                onAddModel={() => setModelEdit({ resourceId: selectedChannel.resource_id })}
                onSelectModel={(m: ModelView) =>
                  setModelEdit({ name: m.name, resourceId: selectedChannel.resource_id })
                }
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
    </div>
  );
}

/** A column's header: title · count · add-action, then a search box + a filter popover. */
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
  /** A custom filter control (FilterMenu) — never a native <select>. */
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
function channelFacetDefs(t: TFunction): FacetDef<ChannelView>[] {
  return [
    {
      key: 'status',
      title: t('channels.form.status'),
      values: (c) => [c.status],
      label: (v) => t('status.' + v, v),
    },
    { key: 'platform', title: t('channels.form.platform'), values: (c) => [c.resource_id] },
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

// Three EQUAL columns (插件 │ 通道 │ 模型) — `.tri-pane` stacks them on a phone.
// A column = a fixed header + a scrolling card list beneath it.
const COL: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};
// The scrolling list: horizontal breathing room so a card's hover-lift shadow +
// `is-selected` ring (a 1px box-shadow) are never clipped at the column edges.
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

import { PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BrandIcon } from '../../components/data/BrandIcon';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
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

/**
 * 模型接入 — the single 3-pane management surface (replaces the platform two-pane
 * catalog + the standalone 插件 page). Left: the provider-plugin library (top
 * grouping; platform stays in the DB for routing but is hidden here). Middle: the
 * channels bound to the selected plugin (across resources). Right: the selected
 * channel's served-model grid. Platform-level pricing/resource CRUD live on the
 * secondary 平台与定价 view (linked from the header).
 */
export function ModelAccessPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  // `plugin` + `cid` live in one URL so a plugin switch can set the plugin AND
  // clear the channel in a SINGLE navigate — two separate `useUrlState` setters
  // in one handler would each read the render-time snapshot and clobber each other.
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

  const plugins = useQuery({
    queryKey: qk.plugins(),
    queryFn: () => api.listPlugins(),
    staleTime: STALE_REFERENCE,
  });
  const pluginRows = plugins.data ?? [];
  const selectedPlugin =
    pluginRows.find((p) => p.id === pluginId) ?? (pluginId === '' ? pluginRows[0] : undefined);

  const channels = useQuery({
    queryKey: qk.pluginChannels(selectedPlugin?.id ?? ''),
    queryFn: () => api.listPluginChannels(selectedPlugin?.id ?? ''),
    enabled: selectedPlugin !== undefined,
  });
  const channelRows = channels.data ?? [];
  const selectedChannel =
    channelRows.find((c) => c.id === cid) ?? (cid === '' ? channelRows[0] : undefined);

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
      api.updateChannel(c.resource_id, c.id, { status: c.status === 'active' ? 'disabled' : 'active' }),
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

  useSetConsoleAction(
    () => (
      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <Button variant="ghost" to="/console/platforms">
          {t('modelAccess.platforms')}
        </Button>
        <Button variant="ghost" onClick={() => setPluginEdit('new')}>
          <PlusIcon size={14} weight="bold" /> {t('plugins.new')}
        </Button>
      </div>
    ),
    [t],
  );

  // --- Left: plugin library -------------------------------------------------
  const pluginList = (
    <QueryBoundary query={plugins}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {pluginRows.map((p) => {
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
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
              <div style={{ display: 'flex', gap: 'var(--s-1)', marginTop: 6, flexWrap: 'wrap' }}>
                <span className="chip">{p.builtin ? t('plugins.builtin') : t('plugins.custom')}</span>
                {p.modalities.length > 0 && <span className="chip">{p.modalities.join(', ')}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </QueryBoundary>
  );

  // --- Middle: channels for the selected plugin -----------------------------
  const channelList =
    selectedPlugin === undefined ? (
      <Placeholder text={t('modelAccess.pickPlugin')} />
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', fontWeight: 'var(--fw-medium)' }}>
            {t('modelAccess.channels')} · {selectedPlugin.label}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setChannelEdit('new')}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('modelAccess.addChannel')}
          </Button>
        </div>
        <QueryBoundary query={channels}>
          {channelRows.length === 0 ? (
            <Placeholder text={t('modelAccess.noChannels')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              {channelRows.map((c) => (
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
              ))}
            </div>
          )}
        </QueryBoundary>
      </div>
    );

  // --- Right: the selected channel's model grid -----------------------------
  const modelPane =
    selectedChannel === undefined ? (
      <Placeholder text={t('modelAccess.pickChannel')} />
    ) : (
      <ModelGrid
        resourceId={selectedChannel.resource_id}
        channel={selectedChannel}
        syncing={syncChannel.isPending && syncChannel.variables.id === selectedChannel.id}
        onSync={() => syncChannel.mutate(selectedChannel)}
        onAddModel={() => setModelEdit({ resourceId: selectedChannel.resource_id })}
        onSelectModel={(m: ModelView) =>
          setModelEdit({ name: m.name, resourceId: selectedChannel.resource_id })
        }
      />
    );

  return (
    <div style={WRAP}>
      <div style={COL}>{pluginList}</div>
      <div style={COL}>{channelList}</div>
      <div style={COL}>{modelPane}</div>

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

function Placeholder({ text }: { text: string }) {
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
      {text}
    </div>
  );
}

// 3 columns: 插件 (3) │ 通道 (2) │ 模型 (4) — the spec's 1/3 │ (1/3 of 2/3) │ (2/3 of 2/3).
const WRAP: CSSProperties = {
  height: '100%',
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 3fr) minmax(240px, 2.4fr) minmax(360px, 4.6fr)',
  gap: 'var(--s-3)',
};
// A scroll column with horizontal breathing room so a card's hover-lift shadow +
// `is-selected` ring (a 1px box-shadow) are never clipped at the column edges.
const COL: CSSProperties = {
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 'var(--s-1) var(--s-2) var(--s-4)',
};

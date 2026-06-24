import { ArrowsClockwiseIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { QueryBoundary } from '../../components/data/QueryBoundary';
import { Button } from '../../components/ui/Button';
import { enumLabel, MODALITIES } from '../../lib/api/enums';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, ModelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/** µUSD/1M string → `$X.XX`. */
function usd(micro: string): string {
  return `$${(Number(micro) / 1_000_000).toFixed(2)}`;
}

/**
 * The right pane of the platform detail (catalog supply-hierarchy): the models
 * the selected channel serves, as a card grid. `模型同步` re-discovers from the
 * upstream; `关联模型` links an existing platform model; clicking a card opens its
 * detail popup. Owns its own `channelModels` query so link/unlink/sync refetch it.
 */
export function ModelGrid({
  resourceId,
  channel,
  onSync,
  onAddModel,
  onSelectModel,
  syncing,
}: {
  resourceId: string;
  channel: ChannelView;
  onSync: () => void;
  onAddModel: () => void;
  onSelectModel: (m: ModelView) => void;
  syncing?: boolean;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const query = useQuery({
    queryKey: qk.channelModels(channel.id),
    queryFn: () => api.listChannelModels(resourceId, channel.id),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', fontWeight: 'var(--fw-medium)' }}>
          {t('resources.detail.servedModels')} · {channel.provider_type}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={onSync} loading={syncing}>
          <ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" /> {t('channels.actions.syncModels')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onAddModel}>
          <PlusIcon size={14} weight="bold" aria-hidden="true" /> {t('models.link')}
        </Button>
      </div>

      <QueryBoundary query={query}>
        {(query.data ?? []).length === 0 ? (
          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-6)',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            {t('resources.detail.noChannelModels')}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 'var(--s-3)',
            }}
          >
            {(query.data ?? []).map((m) => (
              <ModelCard key={m.id} model={m} onClick={() => onSelectModel(m)} t={t} />
            ))}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function ModelCard({
  model,
  onClick,
  t,
}: {
  model: ModelView;
  onClick: () => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const priced = model.input_price !== '0' || model.output_price !== '0';
  const dot = model.status === 'active' ? 'var(--ok)' : 'var(--faint)';
  return (
    <button
      type="button"
      className="entity-card is-clickable"
      onClick={onClick}
      style={{ textAlign: 'left', padding: 'var(--s-3) var(--s-4)', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
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
          {model.name}
        </span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} aria-hidden="true" />
      </div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)', marginTop: 6 }}>
        {enumLabel(t, MODALITIES, model.modality)}
        {model.maker !== null && ` · ${model.maker}`}
      </div>
      <div className="tabular" style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)', marginTop: 4 }}>
        {priced ? `${usd(model.input_price)} / ${usd(model.output_price)}` : t('models.unpriced')}
      </div>
      {model.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)', marginTop: 6 }}>
          {model.tags.slice(0, 3).map((tg) => (
            <span key={tg} className="chip" style={{ fontSize: 'var(--fs-caption)' }}>
              {tg}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

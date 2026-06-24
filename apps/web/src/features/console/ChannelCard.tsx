import {
  ArrowsClockwiseIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandIcon } from '../../components/data/BrandIcon';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { RowAction } from '../../components/ui/RowAction';
import type { ChannelView } from '../../lib/api/types';

/** Strip the scheme/path from an endpoint URL for a compact card subtitle. */
function hostOf(endpoint: string | null): string {
  if (endpoint === null || endpoint === '') return '—';
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * One upstream channel in the platform detail's left rail (catalog
 * supply-hierarchy). Selecting it loads its served-model grid on the right. The
 * row-actions (edit / enable-disable / 模型同步 / delete) stop propagation so they
 * don't also toggle the selection.
 */
export function ChannelCard({
  channel,
  selected,
  onSelect,
  onEdit,
  onToggle,
  onSync,
  onDelete,
  toggling,
  syncing,
}: {
  channel: ChannelView;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onSync: () => void;
  onDelete: () => void;
  toggling?: boolean;
  syncing?: boolean;
}) {
  const { t } = useTranslation('console');
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      className={`entity-card is-clickable${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={onKey}
      style={{ padding: 'var(--s-3) var(--s-4)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
        <BrandIcon icon={channel.icon} fallbacks={[channel.provider_type]} size={18} />
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
          {channel.provider_type}
        </span>
        <StatusBadge tone={statusTone(channel.status)} label={t('status.' + channel.status, channel.status)} />
      </div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)', marginTop: 4 }}>
        {hostOf(channel.endpoint)}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-2)',
          marginTop: 'var(--s-2)',
          flexWrap: 'wrap',
        }}
      >
        <span className="chip">{t('resources.cards.modelsN', { n: channel.model_count })}</span>
        <span className="chip">{t('channels.cols.weight')} {channel.weight}</span>
        <span style={{ flex: 1 }} />
        <span onClick={stop} onKeyDown={stop} role="presentation" style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
          <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={onEdit} />
          <RowAction
            icon={channel.status === 'active' ? PauseIcon : PlayIcon}
            label={channel.status === 'active' ? t('channels.actions.disable') : t('channels.actions.enable')}
            loading={toggling}
            onClick={onToggle}
          />
          <RowAction
            icon={ArrowsClockwiseIcon}
            label={t('channels.actions.syncModels')}
            loading={syncing}
            onClick={onSync}
          />
          <RowAction icon={TrashIcon} label={t('channels.actions.delete')} danger onClick={onDelete} />
        </span>
      </div>
    </div>
  );
}

import { ImageIcon, MusicNotesIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

const ICONS = { image: ImageIcon, video: VideoCameraIcon, audio: MusicNotesIcon } as const;

/**
 * Placeholder for the not-yet-built playground modalities (image / video / audio).
 * Each is a deferred sub-project; this keeps the modality reachable from the
 * 2nd-column sub-nav while signalling it's coming.
 */
export function PlaygroundComingSoon({ modality }: { modality: 'image' | 'video' | 'audio' }) {
  const { t } = useTranslation('console');
  const Icon = ICONS[modality];
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-3)',
          color: 'var(--faint)',
          textAlign: 'center',
          padding: 'var(--s-4)',
        }}
      >
        <Icon size={48} weight="duotone" aria-hidden="true" />
        <div style={{ fontSize: 'var(--fs-md)', color: 'var(--muted)' }}>
          {t(`playground.tool.${modality}`)}
        </div>
        <div style={{ fontSize: 'var(--fs-sm)' }}>{t('playground.comingSoonBody')}</div>
      </div>
    </div>
  );
}

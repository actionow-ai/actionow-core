import { ImageIcon, MusicNotesIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Badge, Center } from './welcome-chrome';

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
    <Center>
      <Badge icon={<Icon size={26} weight="fill" />} accent />
      <h2
        style={{
          margin: 0,
          fontSize: 'var(--fs-lg)',
          fontWeight: 'var(--fw-semibold)',
          color: 'var(--text)',
        }}
      >
        {t(`playground.tool.${modality}`)}
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--fs-sm)',
          color: 'var(--faint)',
          maxWidth: '42ch',
          lineHeight: 1.6,
        }}
      >
        {t('playground.comingSoonBody')}
      </p>
    </Center>
  );
}

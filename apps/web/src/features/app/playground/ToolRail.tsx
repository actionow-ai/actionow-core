import {
  ChatCircleIcon,
  type Icon,
  ImageIcon,
  MusicNotesIcon,
  VideoCameraIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/**
 * The playground's modality switcher (the extensibility seam). v1 ships only the
 * Chat tool active; image / video / audio are previewed as disabled icons (a
 * "coming soon" title) so the multi-tool intent is visible. Later sub-projects
 * activate them as routed sibling tools.
 */
export function ToolRail() {
  const { t } = useTranslation('console');
  const soon = t('playground.comingSoon');
  return (
    <nav
      aria-label={t('playground.tools')}
      style={{
        width: 52,
        flexShrink: 0,
        borderRight: '1px solid var(--hairline)',
        background: 'var(--panel-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-2)',
        padding: 'var(--s-3) 0',
      }}
    >
      <Tool icon={ChatCircleIcon} label={t('playground.tool.chat')} active />
      <Tool icon={ImageIcon} label={`${t('playground.tool.image')} · ${soon}`} />
      <Tool icon={VideoCameraIcon} label={`${t('playground.tool.video')} · ${soon}`} />
      <Tool icon={MusicNotesIcon} label={`${t('playground.tool.audio')} · ${soon}`} />
    </nav>
  );
}

function Tool({ icon: IconCmp, label, active }: { icon: Icon; label: string; active?: boolean }) {
  return (
    <span
      title={label}
      aria-label={label}
      aria-current={active === true ? 'page' : undefined}
      style={{
        width: 36,
        height: 36,
        borderRadius: 'var(--r-md)',
        display: 'grid',
        placeItems: 'center',
        background: active === true ? 'var(--glass-bg)' : 'transparent',
        color: active === true ? 'var(--cta)' : 'var(--faint)',
        opacity: active === true ? 1 : 0.5,
        cursor: active === true ? 'default' : 'not-allowed',
      }}
    >
      <IconCmp size={20} weight={active === true ? 'fill' : 'regular'} />
    </span>
  );
}

import { useTranslation } from 'react-i18next';

import { RoseLoader } from './RoseLoader';

/** Full-viewport brand loader for route/page-level waits (Suspense fallback). */
export function LoadingScreen({ label }: { label?: string }) {
  const { t } = useTranslation('common');
  const text = label ?? t('loading');
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div style={{ display: 'grid', gap: 'var(--s-5)', justifyItems: 'center' }}>
        <RoseLoader size={132} label={text} />
        <span
          style={{
            fontSize: 'var(--fs-sm)',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
            whiteSpace: 'nowrap',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
}

import { RocketLaunchIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/**
 * A placeholder body for nav destinations whose backend track hasn't landed yet
 * (分组 / 官方价格 — built as mock pages in Phase 2). Renders a centered
 * "即将上线 / Coming soon" panel so the 计费与路由 nav group reads as complete
 * without dead links that 404. The TopBar still shows the route's own title.
 */
export function ComingSoon() {
  const { t } = useTranslation('console');
  return (
    <div style={{ height: '100%', padding: 'var(--s-2) var(--s-3) var(--s-4)' }}>
      <div
        className="panel"
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-6)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--s-3)', textAlign: 'center' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              width: 48,
              height: 48,
              borderRadius: 'var(--r-md)',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent)',
              background: 'var(--hover-bg)',
              border: '1px solid var(--panel-bd)',
            }}
          >
            <RocketLaunchIcon size={24} weight="duotone" />
          </span>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>
            {t('comingSoon.title')}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', maxWidth: 360 }}>
            {t('comingSoon.body')}
          </div>
        </div>
      </div>
    </div>
  );
}

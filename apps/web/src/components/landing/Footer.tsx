import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Logo } from '../brand/Logo';

export function Footer() {
  const { t } = useTranslation(['landing', 'common']);
  const year = 2026;
  return (
    <footer style={{ borderTop: '1px solid var(--panel-bd)', marginTop: 'var(--s-8)' }}>
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: 'var(--s-10) var(--s-4)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-8)',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ maxWidth: 280 }}>
          <Logo />
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 'var(--s-3)' }}>{t('footer.tagline')}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-16)', flexWrap: 'wrap' }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            <a href="#features" style={{ fontSize: 13, color: 'var(--muted)' }}>{t('nav.features')}</a>
            <a href="#pricing" style={{ fontSize: 13, color: 'var(--muted)' }}>{t('nav.pricing')}</a>
            <a href="#" style={{ fontSize: 13, color: 'var(--muted)' }}>{t('footer.docs')}</a>
            <Link to="/login" style={{ fontSize: 13, color: 'var(--muted)' }}>{t('footer.console')}</Link>
          </nav>
        </div>
      </div>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 var(--s-4) var(--s-8)', fontSize: 12, color: 'var(--faint)' }}>
        © {year} {t('common:brand')}. {t('footer.rights')}
      </div>
    </footer>
  );
}

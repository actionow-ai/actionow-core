import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { config } from '../../config';
import { Logo } from '../brand/Logo';

interface Col {
  heading: string;
  links: { label: string; href?: string; to?: string }[];
}

export function Footer() {
  const { t } = useTranslation(['landing', 'common']);
  const year = 2026;

  const columns: Col[] = [
    {
      heading: t('footer.product'),
      links: [
        { label: t('nav.features'), href: '#features' },
        { label: t('nav.pricing'), href: '#pricing' },
      ],
    },
    {
      heading: t('footer.resources'),
      links: [
        { label: t('footer.docs'), href: '#' },
        { label: t('footer.console'), to: '/login' },
      ],
    },
  ];

  const linkStyle = {
    fontSize: 'var(--fs-sm)',
    color: 'var(--muted)',
    transition: 'color 0.2s',
    whiteSpace: 'nowrap' as const,
  };

  return (
    <footer style={{ borderTop: '1px solid var(--panel-bd)', marginTop: 'var(--s-8)' }}>
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: 'var(--s-10) var(--s-4)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-10)',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ maxWidth: 300 }}>
          <Logo />
          <p
            style={{
              fontSize: 'var(--fs-sm)',
              lineHeight: 1.6,
              color: 'var(--muted)',
              marginTop: 'var(--s-3)',
            }}
          >
            {t('footer.tagline')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-16)', flexWrap: 'wrap' }}>
          {columns.map((col) => (
            <nav
              key={col.heading}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}
            >
              <span
                style={{
                  fontSize: 'var(--fs-caption)',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--faint)',
                }}
              >
                {col.heading}
              </span>
              {col.links.map((l) =>
                l.to ? (
                  <Link key={l.label} to={l.to} style={linkStyle}>
                    {l.label}
                  </Link>
                ) : (
                  <a key={l.label} href={l.href} style={linkStyle}>
                    {l.label}
                  </a>
                ),
              )}
            </nav>
          ))}
        </div>
      </div>
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '0 var(--s-4) var(--s-8)',
          fontSize: 'var(--fs-sm)',
          color: 'var(--faint)',
        }}
      >
        © {year} {config.brandName}. {t('footer.rights')}
      </div>
    </footer>
  );
}

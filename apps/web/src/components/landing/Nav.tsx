import { useTranslation } from 'react-i18next';

import { Logo } from '../brand/Logo';
import { LanguageSwitch } from '../layout/LanguageSwitch';
import { ThemeToggle } from '../layout/ThemeToggle';
import { Button } from '../ui/Button';

export function Nav() {
  const { t } = useTranslation('landing');
  const links = [
    { href: '#features', label: t('nav.features') },
    { href: '#pricing', label: t('nav.pricing') },
    { href: '#', label: t('nav.docs') },
  ];
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 40, padding: 'var(--s-3) var(--s-4)' }}>
      <nav
        className="glass"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          height: 60,
          borderRadius: 'var(--r-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 var(--s-4)',
        }}
      >
        <Logo />
        <div className="hidden md:flex" style={{ alignItems: 'center', gap: 'var(--s-6)' }}>
          {links.map((l) => (
            <a key={l.label} href={l.href} style={{ fontSize: 13.5, color: 'var(--muted)', transition: 'color 0.2s' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}>
              {l.label}
            </a>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <div className="hidden sm:block">
            <LanguageSwitch />
          </div>
          <ThemeToggle />
          <Button to="/login" size="md">{t('nav.login')}</Button>
        </div>
      </nav>
    </header>
  );
}

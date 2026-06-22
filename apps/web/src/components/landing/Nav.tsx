import { ListIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../lib/auth/AuthProvider';
import { homePath } from '../../lib/auth/homePath';
import { BP } from '../../lib/breakpoints';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Z } from '../../lib/zIndex';
import { Logo } from '../brand/Logo';
import { LanguageSwitch } from '../layout/LanguageSwitch';
import { ThemeToggle } from '../layout/ThemeToggle';
import { Button } from '../ui/Button';

export function Nav() {
  const { t } = useTranslation('landing');
  const { user } = useAuth();
  // Route the CTA by role: anonymous → /login, admin → console, tenant → /app.
  // (Previously hardcoded `/console`, which bounces non-admins through a wrong
  // route and anonymous visitors through an extra hop.)
  const consoleHref = homePath(user);
  const isDesktop = useMediaQuery(BP.md);
  const [open, setOpen] = useState(false);
  // Airy glass over the hero; once scrolled, go opaque so content doesn't bleed through.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const links = [
    { href: '#scenarios', label: t('nav.scenarios') },
    { href: '#features', label: t('nav.features') },
    { href: '#pricing', label: t('nav.pricing') },
  ];
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: Z.nav, padding: 'var(--s-3) var(--s-4)' }}>
      <nav
        className="glass"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          minHeight: 60,
          borderRadius: 'var(--r-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 var(--s-4)',
          position: 'relative',
          background: scrolled ? 'var(--nav-bg)' : 'var(--glass-bg)',
          transition: 'background 0.25s ease',
        }}
      >
        <Logo />

        {isDesktop && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)' }}>
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', transition: 'color 0.2s' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
              >
                {l.label}
              </a>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          {isDesktop ? (
            <>
              <LanguageSwitch />
              <ThemeToggle />
              <Button to={consoleHref}>{t('nav.console')}</Button>
            </>
          ) : (
            <button
              type="button"
              className="glass glass-hover"
              aria-label={t('nav.menu')}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              style={{
                width: 38,
                height: 38,
                borderRadius: 'var(--r-pill)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {open ? <XIcon size={17} /> : <ListIcon size={17} />}
            </button>
          )}
        </div>

        {!isDesktop && open && (
          <div
            className="glass"
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              borderRadius: 'var(--r-lg)',
              padding: 'var(--s-4)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-2)',
            }}
          >
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                style={{ fontSize: 'var(--fs-base)', color: 'var(--text)', padding: '8px 6px' }}
              >
                {l.label}
              </a>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
              <LanguageSwitch />
              <ThemeToggle />
              <Button to={consoleHref}>{t('nav.console')}</Button>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}

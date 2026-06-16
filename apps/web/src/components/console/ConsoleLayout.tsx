import { SignOutIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../lib/auth/AuthProvider';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AppBackground } from '../glass/AppBackground';
import { LanguageSwitch } from '../layout/LanguageSwitch';
import { ThemeToggle } from '../layout/ThemeToggle';
import { activeItem, groupForPath, MOBILE_TABS, NAV } from './nav-config';

function Rail({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const active = groupForPath(pathname);
  return (
    <div
      className="glass"
      style={{
        width: 56,
        borderRadius: 'var(--r-lg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-3)',
        padding: 'var(--s-4) 0',
      }}
    >
      {NAV.map((g) => {
        const GroupIcon = g.icon;
        const on = g.key === active.key;
        return (
          <button
            key={g.key}
            type="button"
            aria-label={g.key}
            aria-current={on ? 'true' : undefined}
            onClick={() => void navigate(g.items[0].to)}
            style={{
              width: 38,
              height: 38,
              borderRadius: 'var(--r-sm)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              color: on ? 'var(--ink)' : 'var(--muted)',
              background: on ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'transparent',
              boxShadow: on ? '0 4px 14px rgba(255,176,10,.45)' : undefined,
            }}
          >
            <GroupIcon size={19} weight={on ? 'fill' : 'regular'} />
          </button>
        );
      })}
    </div>
  );
}

function SubNav({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const group = groupForPath(pathname);
  return (
    <div className="glass" style={{ width: 184, borderRadius: 'var(--r-lg)', padding: 'var(--s-4) var(--s-3)' }}>
      <div
        style={{
          fontSize: 9,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
          margin: '0 var(--s-2) 8px',
        }}
      >
        {t(`nav.groups.${group.key}`)}
      </div>
      {group.items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          style={({ isActive }) => ({
            display: 'block',
            padding: '9px 10px',
            borderRadius: 'var(--r-sm)',
            marginBottom: 2,
            fontSize: 12.5,
            color: isActive ? 'var(--text)' : 'var(--muted)',
            background: isActive ? 'rgba(255,214,10,.13)' : 'transparent',
            border: isActive ? '1px solid rgba(255,214,10,.28)' : '1px solid transparent',
          })}
        >
          {t(`nav.${it.labelKey}`)}
        </NavLink>
      ))}
    </div>
  );
}

function TopBar({ title }: { title: string }) {
  const { t } = useTranslation('console');
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div
      className="glass"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 'var(--s-2)',
        padding: 'var(--s-3) var(--s-4)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', flexShrink: 0 }}>{title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <Link
          to="/"
          className="glass glass-hover"
          style={{ fontSize: 12, color: 'var(--muted)', padding: '7px 12px', borderRadius: 'var(--r-pill)', whiteSpace: 'nowrap' }}
        >
          {t('topbar.backHome')}
        </Link>
        <LanguageSwitch />
        <ThemeToggle />
        <button
          type="button"
          onClick={() => {
            logout();
            void navigate('/login', { replace: true });
          }}
          className="glass glass-hover"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text)',
            cursor: 'pointer',
            padding: '7px 12px',
            borderRadius: 'var(--r-pill)',
            whiteSpace: 'nowrap',
          }}
        >
          <SignOutIcon size={15} />
          {t('topbar.logout')}
        </button>
      </span>
    </div>
  );
}

function BottomTabs({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  return (
    <nav
      className="glass"
      style={{
        position: 'fixed',
        left: 'var(--s-3)',
        right: 'var(--s-3)',
        bottom: 'var(--s-3)',
        zIndex: 30,
        borderRadius: 'var(--r-lg)',
        display: 'flex',
        justifyContent: 'space-around',
        padding: 'var(--s-2)',
      }}
    >
      {MOBILE_TABS.map((tab) => {
        const TabIcon = tab.icon;
        const on = pathname.startsWith(tab.to);
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              fontSize: 10,
              padding: '6px 12px',
              borderRadius: 'var(--r-sm)',
              color: on ? 'var(--accent)' : 'var(--muted)',
            }}
          >
            <TabIcon size={20} weight={on ? 'fill' : 'regular'} />
            {t(`nav.${tab.labelKey}`)}
          </NavLink>
        );
      })}
    </nav>
  );
}

export function ConsoleLayout() {
  const { t } = useTranslation('console');
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const title = t(`nav.${activeItem(pathname).labelKey}`);
  return (
    <>
      <AppBackground />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 'var(--s-3)', padding: 'var(--s-4)', height: '100dvh' }}>
        {isDesktop && <Rail pathname={pathname} />}
        {isDesktop && <SubNav pathname={pathname} />}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <TopBar title={title} />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 2, paddingBottom: isDesktop ? 0 : 76 }}>
            <Outlet />
          </div>
        </main>
      </div>
      {!isDesktop && <BottomTabs pathname={pathname} />}
    </>
  );
}

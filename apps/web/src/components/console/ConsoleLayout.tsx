import { ArrowLeftIcon, ArrowsClockwiseIcon, HouseIcon, MoonIcon, SignOutIcon, SunIcon, TranslateIcon } from '@phosphor-icons/react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../lib/auth/AuthProvider';
import { BP } from '../../lib/breakpoints';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { useTheme } from '../../lib/theme/ThemeProvider';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AppBackground } from '../glass/AppBackground';
import { LanguageSwitch } from '../layout/LanguageSwitch';
import { ThemeToggle } from '../layout/ThemeToggle';
import type { ConsoleBack } from './ConsoleChrome';
import { ConsoleActionContext, ConsoleBackContext, ConsoleFiltersContext } from './ConsoleChrome';
import { activeItem, groupForPath, MOBILE_TABS, NAV } from './nav-config';

const RAIL_STEP = 52; // 40px button + 12px gap
const SUBNAV_STEP = 38; // 34px item + 4px gap
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** Square icon button with a tooltip that slides out to its right on hover. */
function RailButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`ico-btn${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
      <span className="ico-tip">{label}</span>
    </button>
  );
}

function Rail({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const { t: tc } = useTranslation();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();

  const activeIdx = NAV.findIndex((g) => g.key === groupForPath(pathname).key);
  const isZh = i18n.language.startsWith('zh');

  return (
    <div
      className="glass"
      style={{ width: 64, borderRadius: 'var(--r-lg)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--s-4)', padding: 'var(--s-4) 0' }}
    >
      <RailButton label={t('topbar.backHome')} onClick={() => void navigate('/')}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            boxShadow: 'var(--glow-accent)',
          }}
        >
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          </svg>
        </span>
      </RailButton>

      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--s-3)' }}>
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            width: 40,
            height: 40,
            marginLeft: -20,
            borderRadius: 'var(--r-sm)',
            background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            boxShadow: 'var(--shadow-cta)',
            zIndex: 0,
            opacity: activeIdx >= 0 ? 1 : 0,
            transform: `translateY(${String(Math.max(activeIdx, 0) * RAIL_STEP)}px)`,
            transition: reduced ? 'none' : `transform 0.32s ${EASE}`,
          }}
        />
        {NAV.map((g, i) => {
          const GroupIcon = g.icon;
          const on = i === activeIdx;
          return (
            <RailButton key={g.key} label={t(`nav.groups.${g.key}`)} active={on} onClick={() => void navigate(g.items[0].to)}>
              <GroupIcon size={19} weight={on ? 'fill' : 'regular'} />
            </RailButton>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--s-2)' }}>
        <RailButton label={isZh ? tc('lang.en') : tc('lang.zh')} onClick={() => void i18n.changeLanguage(isZh ? 'en' : 'zh-CN')}>
          <TranslateIcon size={18} />
        </RailButton>
        <RailButton label={theme === 'dark' ? tc('theme.toLight') : tc('theme.toDark')} onClick={toggle}>
          {theme === 'dark' ? <MoonIcon size={18} /> : <SunIcon size={18} />}
        </RailButton>
        <RailButton
          label={t('topbar.logout')}
          onClick={() => {
            logout();
            void navigate('/login', { replace: true });
          }}
        >
          <SignOutIcon size={18} />
        </RailButton>
      </div>
    </div>
  );
}

function SubNav({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const reduced = useReducedMotion();
  const group = groupForPath(pathname);
  const activeIdx = group.items.findIndex((it) => pathname.startsWith(it.to));

  return (
    <div className="glass" style={{ width: 200, borderRadius: 'var(--r-lg)', padding: 'var(--s-4) var(--s-3)' }}>
      <div style={{ fontSize: 'var(--fs-caption)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--faint)', margin: '0 var(--s-2) var(--s-3)' }}>
        {t(`nav.groups.${group.key}`)}
      </div>
      <div style={{ position: 'relative' }}>
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: 34,
            boxSizing: 'border-box',
            borderRadius: 'var(--r-sm)',
            background: 'var(--hover-bg)',
            border: '1px solid var(--hover-bd)',
            opacity: activeIdx >= 0 ? 1 : 0,
            transform: `translateY(${String(Math.max(activeIdx, 0) * SUBNAV_STEP)}px)`,
            transition: reduced ? 'none' : `transform 0.26s ${EASE}`,
          }}
        />
        {group.items.map((it, i) => (
          <NavLink
            key={it.to}
            to={it.to}
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              height: 34,
              marginBottom: 4,
              padding: '0 10px',
              borderRadius: 'var(--r-sm)',
              fontSize: 'var(--fs-sm)',
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              color: i === activeIdx ? 'var(--text)' : 'var(--muted)',
            }}
          >
            {t(`nav.${it.labelKey}`)}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function TopBar({ action, filters, back }: { action: ReactNode; filters: ReactNode; back: ConsoleBack | null }) {
  const { t } = useTranslation('console');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const reduced = useReducedMotion();
  const isDesktop = useMediaQuery(BP.md);

  const item = activeItem(pathname);
  const subtitle = t(`subtitles.${item.labelKey}`, '');

  return (
    <div
      className="glass"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: isDesktop ? 'nowrap' : 'wrap',
        gap: 'var(--s-3)',
        padding: 'var(--s-3) var(--s-4)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
        {back !== null && (
          <button type="button" className="ico-btn" aria-label={back.label} onClick={() => void navigate(back.to)} style={{ flexShrink: 0 }}>
            <ArrowLeftIcon size={17} />
          </button>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)', letterSpacing: 'var(--track-snug)', whiteSpace: 'nowrap' }}>
            {t(`nav.${item.labelKey}`)}
          </div>
          {isDesktop && subtitle !== '' && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexShrink: 0 }}>
        {filters}
        {action}
        <button type="button" className="ico-btn" aria-label={t('topbar.refresh')} onClick={() => void qc.invalidateQueries()}>
          <ArrowsClockwiseIcon size={17} className={fetching > 0 && !reduced ? 'refresh-spin' : undefined} />
        </button>
        {!isDesktop && (
          <>
            <LanguageSwitch />
            <ThemeToggle />
            <button type="button" className="ico-btn" aria-label={t('topbar.backHome')} onClick={() => void navigate('/')}>
              <HouseIcon size={16} />
            </button>
            <button
              type="button"
              className="ico-btn"
              aria-label={t('topbar.logout')}
              onClick={() => {
                logout();
                void navigate('/login', { replace: true });
              }}
            >
              <SignOutIcon size={16} />
            </button>
          </>
        )}
      </div>
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
              whiteSpace: 'nowrap',
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
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery(BP.md);
  const [action, setAction] = useState<ReactNode>(null);
  const [filters, setFilters] = useState<ReactNode>(null);
  const [back, setBack] = useState<ConsoleBack | null>(null);

  return (
    <ConsoleActionContext.Provider value={setAction}>
      <ConsoleFiltersContext.Provider value={setFilters}>
        <ConsoleBackContext.Provider value={setBack}>
        <AppBackground />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 'var(--s-3)', padding: 'var(--s-4)', height: '100dvh' }}>
          {isDesktop && <Rail pathname={pathname} />}
          {isDesktop && <SubNav pathname={pathname} />}
          <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <TopBar action={action} filters={filters} back={back} />
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--s-3)', paddingBottom: isDesktop ? 'var(--s-3)' : 76 }}>
              <div style={{ width: '100%', height: '100%' }}>
                <Outlet />
              </div>
            </div>
          </main>
        </div>
        {!isDesktop && <BottomTabs pathname={pathname} />}
        </ConsoleBackContext.Provider>
      </ConsoleFiltersContext.Provider>
    </ConsoleActionContext.Provider>
  );
}

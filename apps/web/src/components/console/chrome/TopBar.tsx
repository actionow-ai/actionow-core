import { ArrowLeftIcon, ArrowsClockwiseIcon, HouseIcon, SignOutIcon } from '@phosphor-icons/react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../../lib/auth/AuthProvider';
import { BP } from '../../../lib/breakpoints';
import { useReducedMotion } from '../../../lib/motion/useReducedMotion';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { LanguageSwitch } from '../../layout/LanguageSwitch';
import { ThemeToggle } from '../../layout/ThemeToggle';
import { IconButton } from '../../ui/IconButton';
import type { ConsoleBack } from '../ConsoleChrome';
import { activeItem } from '../nav-config';

/** The top bar: page title + subtitle, an optional back target, the page's filter/action slots, a refresh control, and the mobile-only chrome cluster. */
export function TopBar({
  action,
  filters,
  back,
}: {
  action: ReactNode;
  filters: ReactNode;
  back: ConsoleBack | null;
}) {
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

  const titleBlock = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0, flex: 1 }}>
      {back !== null && (
        <span style={{ flexShrink: 0 }}>
          <IconButton
            icon={ArrowLeftIcon}
            label={back.label}
            size={17}
            onClick={() => void navigate(back.to)}
          />
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--fs-lg)',
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: 'var(--track-snug)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t(`nav.${item.labelKey}`)}
        </div>
        {isDesktop && subtitle !== '' && (
          <div
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--muted)',
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );

  const refreshBtn = (
    <button
      type="button"
      className="ico-btn"
      aria-label={t('topbar.refresh')}
      onClick={() => void qc.invalidateQueries()}
    >
      <ArrowsClockwiseIcon
        size={17}
        className={fetching > 0 && !reduced ? 'refresh-spin' : undefined}
      />
    </button>
  );

  // The page-provided filter/action slots. On mobile they get their OWN row so a
  // wide filter (e.g. a 200px TenantSelect) can't push the chrome icons off-screen.
  const pageSlots =
    (filters !== null && filters !== undefined) || (action !== null && action !== undefined) ? (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-2)',
          flexWrap: 'wrap',
          minWidth: 0,
        }}
      >
        {filters}
        {action}
      </div>
    ) : null;

  // The always-on icon cluster. On mobile it also carries lang/theme/home/logout
  // (which live in the Rail on desktop); it stays right-aligned and never shrinks.
  const iconCluster = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexShrink: 0 }}>
      {refreshBtn}
      {!isDesktop && (
        <>
          <LanguageSwitch />
          <ThemeToggle />
          <IconButton
            icon={HouseIcon}
            label={t('topbar.backHome')}
            size={16}
            onClick={() => void navigate('/')}
          />
          <IconButton
            icon={SignOutIcon}
            label={t('topbar.logout')}
            size={16}
            onClick={() => {
              logout();
              void navigate('/login', { replace: true });
            }}
          />
        </>
      )}
    </div>
  );

  // Desktop: a single row [title … filters action refresh]. Mobile: row 1 is
  // [title … icon cluster] (title ellipsizes, icons fit), and the page slots wrap
  // onto their own full-width row 2 — so nothing overflows the viewport.
  if (isDesktop) {
    return (
      <div
        className="glass"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-3)',
          padding: 'var(--s-3) var(--s-4)',
          borderRadius: 'var(--r-md)',
        }}
      >
        {titleBlock}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexShrink: 0 }}>
          {pageSlots}
          {iconCluster}
        </div>
      </div>
    );
  }

  return (
    <div
      className="glass"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-3)',
        padding: 'var(--s-3) var(--s-4)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        {titleBlock}
        {iconCluster}
      </div>
      {pageSlots !== null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-2)',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
          }}
        >
          {filters}
          {action}
        </div>
      )}
    </div>
  );
}

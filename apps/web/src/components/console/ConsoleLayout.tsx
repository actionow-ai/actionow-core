import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { BP } from '../../lib/breakpoints';
import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { AppBackground } from '../glass/AppBackground';
import { BottomTabs } from './chrome/BottomTabs';
import { Rail } from './chrome/Rail';
import { SubNav } from './chrome/SubNav';
import { TopBar } from './chrome/TopBar';
import type { ConsoleBack } from './ConsoleChrome';
import {
  ConsoleActionContext,
  ConsoleBackContext,
  ConsoleFiltersContext,
  NavConfigContext,
} from './ConsoleChrome';
import { ADMIN_NAV_CONFIG, type NavConfig } from './nav-config';

/**
 * Composition root for the console shell: provides the action/filters/back slots
 * and the nav set, and lays out the chrome around the routed `<Outlet/>`. `nav`
 * defaults to the admin nav; the tenant `/app` shell passes its own set. `status`
 * is an optional always-visible top-bar slot (the `/app` current-role chip).
 */
export function ConsoleLayout({
  nav = ADMIN_NAV_CONFIG,
  status = null,
}: { nav?: NavConfig; status?: ReactNode } = {}) {
  const { pathname } = useLocation();
  const isDesktop = useMediaQuery(BP.md);
  const [action, setAction] = useState<ReactNode>(null);
  const [filters, setFilters] = useState<ReactNode>(null);
  const [back, setBack] = useState<ConsoleBack | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  // Route transition: a quick enter (fade + slide-up) on the routed view each
  // time the path changes. Transform/opacity only, so the scroll/fill layout is
  // untouched; reduced-motion skips it (matchMedia no-preference branch only).
  // revertOnUpdate reverts the prior run so per-path contexts don't accumulate.
  useGSAP(
    () => {
      const el = viewRef.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out },
        );
      });
    },
    { dependencies: [pathname], revertOnUpdate: true },
  );

  return (
    <NavConfigContext.Provider value={nav}>
      <ConsoleActionContext.Provider value={setAction}>
        <ConsoleFiltersContext.Provider value={setFilters}>
          <ConsoleBackContext.Provider value={setBack}>
            <AppBackground />
            <div
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                gap: 'var(--s-3)',
                padding: 'var(--s-4)',
                // Clear the device home-indicator on mobile (env() is 0 elsewhere).
                paddingBottom: 'calc(var(--s-4) + env(safe-area-inset-bottom, 0px))',
                height: '100dvh',
              }}
            >
              {isDesktop && <Rail pathname={pathname} />}
              {isDesktop && <SubNav pathname={pathname} />}
              <main
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--s-3)',
                }}
              >
                <TopBar action={action} filters={filters} back={back} status={status} />
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 0 }}>
                  <div ref={viewRef} style={{ width: '100%', height: '100%' }}>
                    <Outlet />
                  </div>
                </div>
                {/* In-flow (not fixed): the bar is the last flex item, so the
                  scroll area above is bounded by it and a page's last rows can
                  never hide behind it — no matter the page's scroll model. */}
                {!isDesktop && <BottomTabs pathname={pathname} />}
              </main>
            </div>
          </ConsoleBackContext.Provider>
        </ConsoleFiltersContext.Provider>
      </ConsoleActionContext.Provider>
    </NavConfigContext.Provider>
  );
}

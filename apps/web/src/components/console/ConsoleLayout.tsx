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
import { ConsoleActionContext, ConsoleBackContext, ConsoleFiltersContext } from './ConsoleChrome';

/** Composition root for the console shell: provides the action/filters/back slots and lays out the chrome around the routed `<Outlet/>`. */
export function ConsoleLayout() {
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
        gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out });
      });
    },
    { dependencies: [pathname], revertOnUpdate: true },
  );

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
                <div ref={viewRef} style={{ width: '100%', height: '100%' }}>
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

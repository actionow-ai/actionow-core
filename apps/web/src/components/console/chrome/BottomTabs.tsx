import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

import { MOBILE_TABS } from '../nav-config';

/** The mobile bottom tab bar (fixed), one tab per top-level destination. */
export function BottomTabs({ pathname }: { pathname: string }) {
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
              fontSize: 'var(--fs-micro)',
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

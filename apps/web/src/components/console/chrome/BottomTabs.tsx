import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

import { useNavConfig } from '../ConsoleChrome';

/**
 * The mobile bottom tab bar — an IN-FLOW flex item (the last child of `main`),
 * not `position:fixed`. Being in layout means the scroll area above it is
 * bounded by it, so page content can never scroll behind the bar.
 */
export function BottomTabs({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const { mobileTabs } = useNavConfig();
  return (
    <nav
      className="glass"
      style={{
        flexShrink: 0,
        borderRadius: 'var(--r-lg)',
        display: 'flex',
        justifyContent: 'space-around',
        padding: 'var(--s-2)',
      }}
    >
      {mobileTabs.map((tab) => {
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
              justifyContent: 'center',
              gap: 'var(--s-1)',
              // design's documented bottom-tab height (≥56px); --min-touch is 44.
              minHeight: 56,
              fontSize: 'var(--fs-micro)',
              padding: 'var(--s-2) 14px',
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

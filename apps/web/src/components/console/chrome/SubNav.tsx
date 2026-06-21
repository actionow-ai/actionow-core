import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';

import { useReducedMotion } from '../../../lib/motion/useReducedMotion';
import { useNavConfig } from '../ConsoleChrome';
import { groupForPath } from '../nav-config';

const SUBNAV_STEP = 42; // 38px item + 4px gap

/** The desktop sub-navigation column for the active nav group, with a sliding highlight behind the current item. */
export function SubNav({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const reduced = useReducedMotion();
  const { groups } = useNavConfig();
  const group = groupForPath(pathname, groups);
  const activeIdx = group.items.findIndex((it) => pathname.startsWith(it.to));

  return (
    <div
      className="glass"
      style={{ width: 200, borderRadius: 'var(--r-lg)', padding: 'var(--s-4) var(--s-3)' }}
    >
      <div
        style={{
          fontSize: 'var(--fs-caption)',
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
          margin: '0 var(--s-2) var(--s-3)',
        }}
      >
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
            height: 38,
            boxSizing: 'border-box',
            borderRadius: 'var(--r-sm)',
            background: 'var(--hover-bg)',
            border: '1px solid var(--hover-bd)',
            opacity: activeIdx >= 0 ? 1 : 0,
            transform: `translateY(${String(Math.max(activeIdx, 0) * SUBNAV_STEP)}px)`,
            transition: reduced ? 'none' : 'transform var(--dur-base) var(--ease-out)',
          }}
        />
        {group.items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            // Drive the active colour from NavLink's own `isActive` so it can
            // never disagree with the `aria-current="page"` NavLink also sets.
            style={({ isActive }) => ({
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              height: 38,
              marginBottom: 4,
              padding: '0 12px',
              borderRadius: 'var(--r-sm)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 'var(--fw-medium)',
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              transition: 'color var(--dur-fast) var(--ease-out)',
              color: isActive ? 'var(--text)' : 'var(--muted)',
            })}
          >
            {t(`nav.${it.labelKey}`)}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

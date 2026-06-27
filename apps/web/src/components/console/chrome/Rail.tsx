import { MoonIcon, SignOutIcon, SunIcon, TranslateIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../../lib/auth/AuthProvider';
import { useReducedMotion } from '../../../lib/motion/useReducedMotion';
import { useTheme } from '../../../lib/theme/ThemeProvider';
import { IconButton } from '../../ui/IconButton';
import { useNavConfig } from '../ConsoleChrome';
import { groupForPath } from '../nav-config';

const RAIL_STEP = 52; // 40px button + 12px gap

/** The desktop left rail: brand home, the nav-group switcher with a sliding active indicator, and the lang/theme/logout cluster. */
export function Rail({ pathname }: { pathname: string }) {
  const { t } = useTranslation('console');
  const { t: tc } = useTranslation();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();

  const { groups } = useNavConfig();
  const activeIdx = groups.findIndex((g) => g.key === groupForPath(pathname, groups).key);
  const isZh = i18n.language.startsWith('zh');

  return (
    <div
      className="glass"
      style={{
        width: 64,
        borderRadius: 'var(--r-lg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-4)',
        padding: 'var(--s-4) 0',
        // Stacking context above the SubNav so the rail's slide-out `.ico-tip`
        // tooltips (which overflow to the right, into the SubNav's column) are
        // never painted under the SubNav panel.
        position: 'relative',
        zIndex: 50,
      }}
    >
      <button
        type="button"
        className="ico-btn bare"
        aria-label={t('topbar.backHome')}
        onClick={() => void navigate('/')}
      >
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'var(--grad-accent)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            boxShadow: 'var(--glow-accent)',
          }}
        >
          <svg
            width={17}
            height={17}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinejoin="round"
          >
            <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          </svg>
        </span>
        <span className="ico-tip">{t('topbar.backHome')}</span>
      </button>

      <nav
        aria-label={t('a11y.primaryNav')}
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-3)',
        }}
      >
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
            background: 'var(--grad-accent)',
            boxShadow: 'var(--shadow-cta)',
            zIndex: 0,
            opacity: activeIdx >= 0 ? 1 : 0,
            transform: `translateY(${String(Math.max(activeIdx, 0) * RAIL_STEP)}px)`,
            transition: reduced ? 'none' : 'transform var(--dur-base) var(--ease-out)',
          }}
        />
        {groups.map((g, i) => {
          const on = i === activeIdx;
          return (
            <IconButton
              key={g.key}
              icon={g.icon}
              label={t(`nav.groups.${g.key}`)}
              active={on}
              current={on}
              tooltip
              bare
              size={19}
              weight={on ? 'fill' : 'regular'}
              onClick={() => {
                const first = g.items[0];
                if (first !== undefined) void navigate(first.to);
              }}
            />
          );
        })}
      </nav>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-2)',
        }}
      >
        <IconButton
          icon={TranslateIcon}
          label={isZh ? tc('lang.en') : tc('lang.zh')}
          tooltip
          bare
          onClick={() => void i18n.changeLanguage(isZh ? 'en' : 'zh-CN')}
        />
        <IconButton
          icon={theme === 'dark' ? MoonIcon : SunIcon}
          label={theme === 'dark' ? tc('theme.toLight') : tc('theme.toDark')}
          tooltip
          bare
          onClick={toggle}
        />
        <IconButton
          icon={SignOutIcon}
          label={t('topbar.logout')}
          tooltip
          bare
          onClick={() => {
            logout();
            void navigate('/login', { replace: true });
          }}
        />
      </div>
    </div>
  );
}

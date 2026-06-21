import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../lib/theme/ThemeProvider';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
      className="glass glass-hover"
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
      {theme === 'dark' ? <MoonIcon size={17} weight="regular" /> : <SunIcon size={17} weight="regular" />}
    </button>
  );
}

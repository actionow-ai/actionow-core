import { TranslateIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { useMediaQuery } from '../../lib/useMediaQuery';

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const isZh = i18n.language.startsWith('zh');
  const next = isZh ? 'en' : 'zh-CN';
  const label = isZh ? t('lang.en') : t('lang.zh');
  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next)}
      aria-label={label}
      className="glass glass-hover"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: isDesktop ? 7 : 0,
        fontSize: 12.5,
        color: 'var(--text)',
        cursor: 'pointer',
        padding: isDesktop ? '8px 13px' : 0,
        width: isDesktop ? undefined : 38,
        height: isDesktop ? undefined : 38,
        borderRadius: 'var(--r-pill)',
        whiteSpace: 'nowrap',
      }}
    >
      <TranslateIcon size={16} />
      {isDesktop && label}
    </button>
  );
}

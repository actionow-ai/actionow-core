import { TranslateIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

export function LanguageSwitch() {
  const { i18n, t } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const next = isZh ? 'en' : 'zh-CN';
  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next)}
      className="glass glass-hover"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 12.5,
        color: 'var(--text)',
        cursor: 'pointer',
        padding: '8px 13px',
        borderRadius: 'var(--r-pill)',
      }}
    >
      <TranslateIcon size={16} />
      {isZh ? t('lang.en') : t('lang.zh')}
    </button>
  );
}

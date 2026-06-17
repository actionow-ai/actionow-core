import { FlaskIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/**
 * A small "演示数据 (mock)" pill, shown near a page title so a mock-skeleton page
 * (the pre-backend billing pages) is never mistaken for live data. Warm-toned
 * (`--wait`) and tokenized; the `title` carries the longer explanation for hover.
 */
export function MockBadge() {
  const { t } = useTranslation('console');
  return (
    <span
      title={t('mock.note')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-caption)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        padding: '3px 9px',
        borderRadius: 'var(--r-pill)',
        color: 'var(--wait)',
        background: 'color-mix(in srgb, var(--wait) 16%, transparent)',
      }}
    >
      <FlaskIcon size={13} weight="bold" aria-hidden="true" />
      {t('mock.badge')}
    </span>
  );
}

import { FlaskIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Pill } from '../ui/Pill';

/**
 * A small "演示数据 (mock)" pill, shown near a page title so a mock-skeleton page
 * (the pre-backend billing pages) is never mistaken for live data. Warm-toned
 * (`--wait`); composes the shared `Pill` primitive. The `title` carries the
 * longer explanation for hover.
 */
export function MockBadge() {
  const { t } = useTranslation('console');
  return (
    <Pill tone="wait" title={t('mock.note')}>
      <FlaskIcon size={13} weight="bold" aria-hidden="true" />
      {t('mock.badge')}
    </Pill>
  );
}

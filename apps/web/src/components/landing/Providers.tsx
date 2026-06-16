import { useTranslation } from 'react-i18next';

import { ProviderLogos } from './ProviderLogos';
import { Reveal } from './Reveal';

export function Providers() {
  const { t } = useTranslation('landing');
  return (
    <section style={{ maxWidth: 1200, margin: '0 auto', padding: 'var(--s-4) var(--s-4) var(--s-8)' }}>
      <Reveal>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--faint)' }}>
            {t('providers.label')}
          </span>
          <ProviderLogos />
        </div>
      </Reveal>
    </section>
  );
}

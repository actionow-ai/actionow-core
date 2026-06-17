import { ArrowRightIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';
import { Reveal } from './Reveal';

export function CTASection() {
  const { t } = useTranslation('landing');
  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-10) var(--s-4) var(--s-16)' }}>
      <Reveal>
        <div
          className="glass"
          style={{
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 'var(--r-lg)',
            padding: 'var(--s-16) var(--s-6)',
            textAlign: 'center',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(80% 120% at 50% 0%, rgba(255, 214, 10, 0.14), transparent 60%)',
              pointerEvents: 'none',
            }}
          />
          <div style={{ position: 'relative' }}>
            <h2 style={{ fontSize: 'var(--fs-h2)', fontWeight: 780, letterSpacing: '-0.02em', margin: 0 }}>
              {t('cta.title')}
            </h2>
            <p style={{ fontSize: 'var(--fs-base)', lineHeight: 1.6, color: 'var(--muted)', margin: 'var(--s-3) auto 0', maxWidth: 460 }}>
              {t('cta.lead')}
            </p>
            <div style={{ marginTop: 'var(--s-6)', display: 'flex', justifyContent: 'center' }}>
              <Button to="/login" variant="cta" size="lg" className="cta-shine">
                {t('cta.button')} <ArrowRightIcon size={16} weight="bold" />
              </Button>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

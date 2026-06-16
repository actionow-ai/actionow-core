import { useTranslation } from 'react-i18next';

import { Reveal } from './Reveal';

const STEPS = ['s1', 's2', 's3'] as const;

export function HowItWorks() {
  const { t } = useTranslation('landing');
  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-10)' }}>
        <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 38px)', fontWeight: 750, letterSpacing: '-0.02em', margin: 0, maxWidth: 560 }}>
          {t('how.title')}
        </h2>
      </Reveal>
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 'var(--s-6)' }}>
        {STEPS.map((s, i) => (
          <Reveal key={s} delay={i * 0.08}>
            <div style={{ borderTop: '1px solid var(--panel-bd)', paddingTop: 'var(--s-4)' }}>
              <span
                style={{
                  display: 'inline-flex',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--accent)',
                  border: '1px solid var(--hover-bd)',
                  marginBottom: 'var(--s-3)',
                }}
              >
                {i + 1}
              </span>
              <div style={{ fontSize: 17, fontWeight: 650, letterSpacing: '-0.01em' }}>{t(`how.steps.${s}.t`)}</div>
              <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)', marginTop: 'var(--s-2)' }}>
                {t(`how.steps.${s}.d`)}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

import { useTranslation } from 'react-i18next';

import { Reveal } from './Reveal';

const STEPS = ['s1', 's2', 's3'] as const;

export function HowItWorks() {
  const { t } = useTranslation('landing');
  return (
    <section style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-10)' }}>
        <h2 style={{ fontSize: 'clamp(28px, 3.6vw, 42px)', fontWeight: 760, letterSpacing: '-0.02em', margin: 0, maxWidth: 560 }}>
          {t('how.title')}
        </h2>
      </Reveal>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
        {/* connecting rail behind the numbered nodes */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 19,
            top: 20,
            bottom: 20,
            width: 2,
            background: 'linear-gradient(var(--accent), transparent)',
            opacity: 0.5,
          }}
        />
        {STEPS.map((s, i) => (
          <Reveal key={s} delay={i * 0.08}>
            <div style={{ display: 'flex', gap: 'var(--s-5)', position: 'relative' }}>
              <span
                style={{
                  width: 40,
                  height: 40,
                  flexShrink: 0,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--accent)',
                  border: '1px solid var(--hover-bd)',
                  background: 'var(--panel-bg)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                }}
              >
                {i + 1}
              </span>
              <div style={{ paddingTop: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' }}>{t(`how.steps.${s}.t`)}</div>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-2)', maxWidth: 520 }}>
                  {t(`how.steps.${s}.d`)}
                </p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

import { useTranslation } from 'react-i18next';

import { Reveal } from './Reveal';

const STEPS = ['s1', 's2', 's3'] as const;

export function HowItWorks() {
  const { t } = useTranslation('landing');
  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-10)', textAlign: 'center' }}>
        <h2
          style={{
            fontSize: 'var(--fs-h2)',
            fontWeight: 'var(--fw-heading)',
            letterSpacing: 'var(--track-tight)',
            margin: 0,
          }}
        >
          {t('how.title')}
        </h2>
      </Reveal>

      <div style={{ position: 'relative' }}>
        {/* horizontal flow line behind the numerals (desktop) */}
        <span
          aria-hidden="true"
          className="how-rail"
          style={{
            position: 'absolute',
            top: 34,
            left: '16%',
            right: '16%',
            height: 1,
            background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
            opacity: 0.4,
          }}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--s-5)',
          }}
        >
          {STEPS.map((s, i) => (
            <Reveal key={s} delay={i * 0.1}>
              <div
                className="panel"
                style={{
                  borderRadius: 'var(--r-lg)',
                  padding: 'var(--s-6)',
                  height: '100%',
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 'var(--fs-lg)',
                    fontWeight: 'var(--fw-bold)',
                    color: 'var(--ink)',
                    background: 'var(--grad-accent)',
                    boxShadow: 'var(--shadow-accent-md)',
                  }}
                >
                  {i + 1}
                </span>
                <div
                  style={{
                    fontSize: 'var(--fs-lg)',
                    fontWeight: 'var(--fw-semibold)',
                    letterSpacing: '-0.01em',
                    marginTop: 'var(--s-4)',
                  }}
                >
                  {t(`how.steps.${s}.t`)}
                </div>
                <p
                  style={{
                    fontSize: 'var(--fs-base)',
                    lineHeight: 1.6,
                    color: 'var(--muted)',
                    marginTop: 'var(--s-2)',
                  }}
                >
                  {t(`how.steps.${s}.d`)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

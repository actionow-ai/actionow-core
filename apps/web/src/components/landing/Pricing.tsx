import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';
import { Reveal } from './Reveal';

export function Pricing() {
  const { t } = useTranslation('landing');
  const cards: { key: string; featured: boolean; to?: string; href?: string }[] = [
    { key: 'self', featured: true, href: '#' },
    { key: 'support', featured: false, href: '#' },
  ];
  return (
    <section
      id="pricing"
      style={{ maxWidth: 980, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}
    >
      <Reveal style={{ marginBottom: 'var(--s-8)', textAlign: 'center' }}>
        <h2
          style={{ fontSize: 'var(--fs-h2)', fontWeight: 780, letterSpacing: '-0.02em', margin: 0 }}
        >
          {t('pricing.title')}
        </h2>
        <p
          style={{
            fontSize: 'var(--fs-base)',
            lineHeight: 1.6,
            color: 'var(--muted)',
            margin: 'var(--s-3) auto 0',
            maxWidth: 520,
          }}
        >
          {t('pricing.lead')}
        </p>
      </Reveal>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--s-4)',
        }}
      >
        {cards.map((c, i) => (
          <Reveal key={c.key} delay={i * 0.08}>
            <div
              className="glass"
              style={{
                borderRadius: 'var(--r-lg)',
                padding: 'var(--s-6)',
                height: '100%',
                borderColor: c.featured ? 'var(--hover-bd)' : undefined,
                boxShadow: c.featured ? 'var(--shadow-accent-card)' : undefined,
              }}
            >
              <div style={{ fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--muted)' }}>
                {t(`pricing.cards.${c.key}.t`)}
              </div>
              <div
                style={{
                  fontSize: 'var(--fs-2xl)',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  margin: 'var(--s-2) 0',
                }}
              >
                {t(`pricing.cards.${c.key}.p`)}
              </div>
              <p
                style={{
                  fontSize: 'var(--fs-sm)',
                  lineHeight: 1.55,
                  color: 'var(--muted)',
                  minHeight: 42,
                }}
              >
                {t(`pricing.cards.${c.key}.d`)}
              </p>
              <div style={{ marginTop: 'var(--s-5)' }}>
                <Button to={c.to} href={c.href} variant={c.featured ? 'cta' : 'ghost'} size="md">
                  {t(`pricing.cards.${c.key}.cta`)}
                </Button>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

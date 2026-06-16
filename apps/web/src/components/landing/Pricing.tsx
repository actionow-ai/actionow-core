import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';
import { Reveal } from './Reveal';

export function Pricing() {
  const { t } = useTranslation('landing');
  const cards: { key: string; featured: boolean; to?: string; href?: string }[] = [
    { key: 'payg', featured: true, to: '/login' },
    { key: 'team', featured: false, href: '#' },
  ];
  return (
    <section id="pricing" style={{ maxWidth: 980, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-8)' }}>
        <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 38px)', fontWeight: 750, letterSpacing: '-0.02em', margin: 0, maxWidth: 620 }}>
          {t('pricing.title')}
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-3)', maxWidth: 520 }}>
          {t('pricing.lead')}
        </p>
      </Reveal>
      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 'var(--s-4)' }}>
        {cards.map((c, i) => (
          <Reveal key={c.key} delay={i * 0.08}>
            <div
              className="glass"
              style={{
                borderRadius: 'var(--r-lg)',
                padding: 'var(--s-6)',
                height: '100%',
                borderColor: c.featured ? 'var(--hover-bd)' : undefined,
                boxShadow: c.featured ? '0 12px 30px rgba(255, 176, 10, 0.18)' : undefined,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>{t(`pricing.cards.${c.key}.t`)}</div>
              <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', margin: 'var(--s-2) 0' }}>
                {t(`pricing.cards.${c.key}.p`)}
              </div>
              <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)', minHeight: 42 }}>
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

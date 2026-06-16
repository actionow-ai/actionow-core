import type { Icon } from '@phosphor-icons/react';
import { ArrowsLeftRightIcon, StackIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { SpotlightCard } from '../glass/SpotlightCard';
import { Reveal } from './Reveal';

function Card({ k, GlyphIcon, index }: { k: string; GlyphIcon: Icon; index: number }) {
  const { t } = useTranslation('landing');
  return (
    <Reveal delay={index * 0.06}>
      <SpotlightCard style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-6)', height: '100%' }}>
        <span
          style={{
            display: 'inline-flex',
            width: 40,
            height: 40,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            marginBottom: 'var(--s-4)',
          }}
        >
          <GlyphIcon size={21} weight="duotone" />
        </span>
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>{t(`scenarios.${k}.t`)}</div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-2)' }}>{t(`scenarios.${k}.d`)}</p>
      </SpotlightCard>
    </Reveal>
  );
}

export function Scenarios() {
  const { t } = useTranslation('landing');
  return (
    <section id="scenarios" style={{ maxWidth: 1100, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-8)', maxWidth: 620 }}>
        <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 38px)', fontWeight: 750, letterSpacing: '-0.02em', margin: 0 }}>
          {t('scenarios.title')}
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-3)' }}>{t('scenarios.lead')}</p>
      </Reveal>
      <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 'var(--s-4)' }}>
        <Card k="ootb" GlyphIcon={StackIcon} index={0} />
        <Card k="relay" GlyphIcon={ArrowsLeftRightIcon} index={1} />
      </div>
    </section>
  );
}

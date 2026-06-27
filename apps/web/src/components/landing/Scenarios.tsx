import type { Icon } from '@phosphor-icons/react';
import { ArrowsLeftRightIcon, StackIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { SpotlightCard } from '../glass/SpotlightCard';
import { Reveal } from './Reveal';

function ScenarioTile({ k, GlyphIcon, index }: { k: string; GlyphIcon: Icon; index: number }) {
  const { t } = useTranslation('landing');
  return (
    <Reveal delay={index * 0.06}>
      <SpotlightCard style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-6)', height: '100%' }}>
        <span
          style={{
            display: 'inline-flex',
            width: 40,
            height: 40,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            background: 'var(--grad-accent)',
            marginBottom: 'var(--s-4)',
          }}
        >
          <GlyphIcon size={21} weight="duotone" />
        </span>
        <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: '-0.01em' }}>
          {t(`scenarios.${k}.t`)}
        </div>
        <p
          style={{
            fontSize: 'var(--fs-base)',
            lineHeight: 1.6,
            color: 'var(--muted)',
            marginTop: 'var(--s-3)',
          }}
        >
          {t(`scenarios.${k}.d`)}
        </p>
      </SpotlightCard>
    </Reveal>
  );
}

export function Scenarios() {
  const { t } = useTranslation('landing');
  return (
    <section
      id="scenarios"
      style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}
    >
      <Reveal style={{ marginBottom: 'var(--s-8)', textAlign: 'center' }}>
        <h2
          style={{ fontSize: 'var(--fs-h2)', fontWeight: 780, letterSpacing: '-0.02em', margin: 0 }}
        >
          {t('scenarios.title')}
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
          {t('scenarios.lead')}
        </p>
      </Reveal>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--s-4)',
        }}
      >
        <ScenarioTile k="ootb" GlyphIcon={StackIcon} index={0} />
        <ScenarioTile k="relay" GlyphIcon={ArrowsLeftRightIcon} index={1} />
      </div>
    </section>
  );
}

import type { Icon } from '@phosphor-icons/react';
import { ArrowRightIcon, ArrowsLeftRightIcon, BookOpenIcon, StackIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { SpotlightCard } from '../glass/SpotlightCard';
import { Button } from '../ui/Button';
import { FlipWords } from './FlipWords';
import { ProviderLogos } from './ProviderLogos';

function CodePanel() {
  const { t } = useTranslation('landing');
  return (
    <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-4)' }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 'var(--s-3)' }}>openai-python</div>
      <pre className="mono" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.8, color: 'var(--text)', overflowX: 'auto' }}>
        <code>
          <span style={{ color: 'var(--faint)' }}>from</span> openai <span style={{ color: 'var(--faint)' }}>import</span> OpenAI
          {'\n\n'}client = OpenAI(
          {'\n'}  base_url=<span style={{ color: 'var(--accent)' }}>"https://your-host/v1"</span>,
          {'\n'}  api_key=<span style={{ color: '#9bdcb0' }}>"ak_•••"</span>,
          {'\n'})
          {'\n'}client.chat.completions.create(
          {'\n'}  model=<span style={{ color: '#9bdcb0' }}>"gpt-4o"</span>, messages=[...],
          {'\n'})
        </code>
      </pre>
      <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 'var(--s-3)' }}>{t('hero.codeCaption')}</div>
    </div>
  );
}

function ScenarioTile({ k, GlyphIcon }: { k: string; GlyphIcon: Icon }) {
  const { t } = useTranslation('landing');
  return (
    <SpotlightCard className="" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-5)', height: '100%' }}>
      <span
        style={{
          display: 'inline-flex',
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink)',
          background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
          marginBottom: 'var(--s-3)',
        }}
      >
        <GlyphIcon size={19} weight="duotone" />
      </span>
      <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>{t(`scenarios.${k}.t`)}</div>
      <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--muted)', marginTop: 'var(--s-2)' }}>{t(`scenarios.${k}.d`)}</p>
    </SpotlightCard>
  );
}

export function HeroBento() {
  const { t } = useTranslation('landing');
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced || !root.current) return;
      const tiles = root.current.querySelectorAll('[data-tile]');
      gsap.from(tiles, { opacity: 0, y: 28, duration: 0.6, ease: 'power3.out', stagger: 0.08 });
    },
    { scope: root, dependencies: [reduced] },
  );

  return (
    <section ref={root} style={{ maxWidth: 1200, margin: '0 auto', padding: 'var(--s-16) var(--s-4) var(--s-10)' }}>
      <div className="hero-bento">
        <div className="hb-left" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
          <div data-tile>
            <h1 style={{ fontSize: 'clamp(38px, 6vw, 72px)', lineHeight: 1.04, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 }}>
              {t('hero.title1')}
              <FlipWords
                words={t('hero.flip', { returnObjects: true }) as string[]}
                style={{
                  background: 'linear-gradient(120deg, var(--accent), var(--accent-2))',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              />
              {t('hero.title2')}
            </h1>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-4)', maxWidth: 520 }}>
              {t('hero.lead')}
            </p>
            <div style={{ display: 'flex', gap: 'var(--s-3)', marginTop: 'var(--s-6)', flexWrap: 'wrap' }}>
              <Button to="/console" variant="cta" size="lg" className="cta-shine">
                {t('hero.ctaPrimary')} <ArrowRightIcon size={16} weight="bold" />
              </Button>
              <Button href="#" variant="ghost" size="lg">
                <BookOpenIcon size={16} /> {t('hero.ctaSecondary')}
              </Button>
            </div>
          </div>

          <div className="hb-scenarios">
            <div data-tile>
              <ScenarioTile k="ootb" GlyphIcon={StackIcon} />
            </div>
            <div data-tile>
              <ScenarioTile k="relay" GlyphIcon={ArrowsLeftRightIcon} />
            </div>
          </div>

          <div data-tile style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-6)', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--faint)' }}>
              {t('compat.label')}
            </span>
            <ProviderLogos />
          </div>
        </div>

        <div className="hb-right" data-tile>
          <CodePanel />
        </div>
      </div>
    </section>
  );
}

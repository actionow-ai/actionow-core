import { ArrowRightIcon, BookOpenIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { Button } from '../ui/Button';
import { FlipWords } from './FlipWords';
import { ProviderLogos } from './ProviderLogos';

export function ImmersiveHero() {
  const { t } = useTranslation('landing');
  const root = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced || !root.current) return;
      gsap.from(root.current.querySelectorAll('[data-r]'), {
        opacity: 0,
        y: 32,
        duration: 0.7,
        ease: 'power3.out',
        stagger: 0.1,
      });
    },
    { scope: root, dependencies: [reduced] },
  );

  return (
    <section
      ref={root}
      style={{
        position: 'relative',
        minHeight: 'calc(100dvh - 84px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 'var(--s-10) var(--s-4) var(--s-16)',
      }}
    >
      <h1
        data-r
        className="headline-nowrap"
        style={{
          fontSize: 'clamp(40px, 8vw, 104px)',
          fontWeight: 850,
          letterSpacing: '-0.04em',
          lineHeight: 0.98,
          margin: 0,
        }}
      >
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

      <p data-r style={{ fontSize: 'clamp(15px, 1.6vw, 18px)', lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-5)', maxWidth: 600 }}>
        {t('hero.lead')}
      </p>

      <div data-r style={{ display: 'flex', gap: 'var(--s-3)', marginTop: 'var(--s-6)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button to="/login" variant="cta" size="lg" className="cta-shine">
          {t('hero.ctaPrimary')} <ArrowRightIcon size={16} weight="bold" />
        </Button>
        <Button href="#features" variant="ghost" size="lg">
          <BookOpenIcon size={16} /> {t('hero.ctaSecondary')}
        </Button>
      </div>

      <div data-r style={{ marginTop: 'var(--s-10)' }}>
        <ProviderLogos />
      </div>

      <div
        data-r
        aria-hidden="true"
        style={{ position: 'absolute', bottom: 'var(--s-5)', fontSize: 11, letterSpacing: '0.14em', color: 'var(--faint)', whiteSpace: 'nowrap' }}
      >
        ↓ {t('live.title')}
      </div>
    </section>
  );
}

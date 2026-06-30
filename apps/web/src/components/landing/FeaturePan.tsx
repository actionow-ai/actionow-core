import type { Icon } from '@phosphor-icons/react';
import {
  ArrowsLeftRightIcon,
  ChartLineIcon,
  ReceiptIcon,
  ShareNetworkIcon,
  TagIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { BP } from '../../lib/breakpoints';
import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { useMediaQuery } from '../../lib/useMediaQuery';

const FEATS: { key: string; Icon: Icon }[] = [
  { key: 'protocol', Icon: ArrowsLeftRightIcon },
  { key: 'selfservice', Icon: UsersThreeIcon },
  { key: 'pricing', Icon: TagIcon },
  { key: 'routing', Icon: ShareNetworkIcon },
  { key: 'billing', Icon: ReceiptIcon },
  { key: 'logs', Icon: ChartLineIcon },
];

function Panel({
  index,
  k,
  Glyph,
  wide,
}: {
  index: number;
  k: string;
  Glyph: Icon;
  wide?: boolean;
}) {
  const { t } = useTranslation('landing');
  return (
    <div
      className="glass"
      style={{
        width: wide ? '100%' : 'min(78vw, 420px)',
        flexShrink: 0,
        borderRadius: 'var(--r-lg)',
        padding: 'var(--s-8)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            display: 'inline-flex',
            width: 44,
            height: 44,
            borderRadius: 'var(--r-sm)',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            background: 'var(--grad-accent)',
          }}
        >
          <Glyph size={23} weight="duotone" />
        </span>
        <span
          className="mono"
          style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}
        >{`0${String(index + 1)}`}</span>
      </div>
      <div
        style={{
          fontSize: 'clamp(22px, 2.6vw, 30px)',
          fontWeight: 'var(--fw-heading)',
          letterSpacing: 'var(--track-tight)',
          marginTop: 'var(--s-5)',
        }}
      >
        {t(`features.items.${k}.t`)}
      </div>
      <p
        style={{
          fontSize: 'var(--fs-base)',
          lineHeight: 1.65,
          color: 'var(--muted)',
          marginTop: 'var(--s-3)',
        }}
      >
        {t(`features.items.${k}.d`)}
      </p>
    </div>
  );
}

export function FeaturePan() {
  const { t } = useTranslation('landing');
  const reduced = useReducedMotion();
  const isDesktop = useMediaQuery(BP.wide);
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const panned = isDesktop && !reduced;

  useGSAP(
    () => {
      if (!panned || !wrap.current || !track.current) return;
      const distance = track.current.scrollWidth - window.innerWidth;
      if (distance <= 0) return;
      gsap.to(track.current, {
        x: -distance,
        ease: 'none',
        scrollTrigger: {
          trigger: wrap.current,
          start: 'top top',
          end: () => `+=${String(distance)}`,
          pin: true,
          scrub: 1,
          invalidateOnRefresh: true,
        },
      });
    },
    { dependencies: [panned] },
  );

  const heading = (
    <h2
      style={{
        fontSize: 'var(--fs-h2)',
        fontWeight: 'var(--fw-heading)',
        letterSpacing: 'var(--track-tight)',
        margin: 0,
        maxWidth: 560,
      }}
    >
      {t('features.title')}
    </h2>
  );

  // Desktop: a pinned section that pans horizontally through the capability panels.
  if (panned) {
    return (
      <section id="features" ref={wrap} style={{ position: 'relative', overflow: 'hidden' }}>
        <div
          ref={track}
          style={{
            display: 'flex',
            height: '100dvh',
            alignItems: 'center',
            gap: 'var(--s-5)',
            padding: '0 8vw',
            width: 'max-content',
          }}
        >
          <div style={{ flexShrink: 0, width: 'min(34vw, 360px)', paddingRight: 'var(--s-6)' }}>
            {heading}
          </div>
          {FEATS.map((f, i) => (
            <Panel key={f.key} index={i} k={f.key} Glyph={f.Icon} />
          ))}
        </div>
      </section>
    );
  }

  // Mobile / reduced-motion: a plain vertical stack of the same panels.
  return (
    <section
      id="features"
      style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}
    >
      <div style={{ marginBottom: 'var(--s-8)' }}>{heading}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        {FEATS.map((f, i) => (
          <Panel key={f.key} index={i} k={f.key} Glyph={f.Icon} wide />
        ))}
      </div>
    </section>
  );
}

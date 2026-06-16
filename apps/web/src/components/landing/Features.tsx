import type { Icon } from '@phosphor-icons/react';
import {
  ArrowsLeftRightIcon,
  ChartLineIcon,
  ReceiptIcon,
  ShareNetworkIcon,
  TagIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Reveal } from './Reveal';

interface Feat {
  key: string;
  Icon: Icon;
  big?: boolean;
}

const FEATS: Feat[] = [
  { key: 'protocol', Icon: ArrowsLeftRightIcon, big: true },
  { key: 'selfservice', Icon: UsersThreeIcon, big: true },
  { key: 'pricing', Icon: TagIcon },
  { key: 'routing', Icon: ShareNetworkIcon },
  { key: 'billing', Icon: ReceiptIcon },
  { key: 'logs', Icon: ChartLineIcon },
];

function FeatureCard({ feat, index }: { feat: Feat; index: number }) {
  const { t } = useTranslation('landing');
  const { Icon } = feat;
  return (
    <Reveal
      delay={index * 0.05}
      className={`glass glass-hover ${feat.big ? 'md:col-span-2' : ''}`}
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--s-5)',
        minHeight: feat.big ? 180 : 150,
      }}
    >
      {feat.big && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(120% 100% at 100% 0%, rgba(255, 214, 10, 0.12), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
      )}
      <div style={{ position: 'relative' }}>
        <span
          style={{
            display: 'inline-flex',
            width: 38,
            height: 38,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--ink)',
            background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            marginBottom: 'var(--s-3)',
          }}
        >
          <Icon size={20} weight="duotone" />
        </span>
        <div style={{ fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em' }}>{t(`features.items.${feat.key}.t`)}</div>
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)', marginTop: 'var(--s-2)', maxWidth: 420 }}>
          {t(`features.items.${feat.key}.d`)}
        </p>
      </div>
    </Reveal>
  );
}

export function Features() {
  const { t } = useTranslation('landing');
  return (
    <section id="features" style={{ maxWidth: 1200, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <Reveal style={{ marginBottom: 'var(--s-8)' }}>
        <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 38px)', fontWeight: 750, letterSpacing: '-0.02em', margin: 0, maxWidth: 560 }}>
          {t('features.title')}
        </h2>
      </Reveal>
      <div className="grid grid-cols-1 md:grid-cols-4" style={{ gap: 'var(--s-3)' }}>
        {FEATS.map((f, i) => (
          <FeatureCard key={f.key} feat={f} index={i} />
        ))}
      </div>
    </section>
  );
}

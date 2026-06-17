import { KeyIcon, SquaresFourIcon, WalletIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { gsap, ScrollTrigger, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';

const STATS = [
  { key: 'tenants', to: 128, suffix: '' },
  { key: 'calls', to: 3402, suffix: '' },
  { key: 'spend', to: 18.6, suffix: 'k' },
] as const;

/** Provider-agnostic, full-modal request stream: chat, image, video, audio, embeddings. */
const LOG = [
  'POST /v1/chat/completions · gpt-4o · 200 · 142ms',
  'POST /v1/images/generations · flux · 200 · 1.2s',
  'POST /v1/video/generations · veo · 202 · queued',
  'POST /v1/audio/speech · tts-1 · 200 · 380ms',
  'POST /v1/chat/completions · claude · 200 · 311ms',
  'POST /v1/embeddings · text-embed · 200 · 64ms',
];

export function LiveConsole() {
  const { t } = useTranslation('landing');
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;

      const setFinal = () => {
        el.querySelectorAll<HTMLElement>('[data-num]').forEach((n) => {
          const to = Number(n.dataset.num);
          const dec = to % 1 !== 0;
          n.textContent = (dec ? to.toFixed(1) : to.toLocaleString()) + (n.dataset.suffix ?? '');
        });
      };

      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // fromTo (explicit start+end) so a re-run can't strand the reveal.
        gsap.fromTo(
          el.querySelectorAll('[data-r]'),
          { opacity: 0, y: 28 },
          {
            opacity: 1,
            y: 0,
            duration: DUR.slow,
            ease: EASE.out,
            stagger: 0.08,
            scrollTrigger: { trigger: el, start: 'top 78%' },
          },
        );

        // Count-up runs once, when the console scrolls into view.
        ScrollTrigger.create({
          trigger: el,
          start: 'top 70%',
          once: true,
          onEnter: () => {
            el.querySelectorAll<HTMLElement>('[data-num]').forEach((n) => {
              const to = Number(n.dataset.num);
              const dec = to % 1 !== 0;
              const suf = n.dataset.suffix ?? '';
              const o = { v: 0 };
              gsap.to(o, {
                v: to,
                duration: 1.4,
                ease: EASE.out,
                onUpdate: () => {
                  n.textContent = (dec ? o.v.toFixed(1) : Math.round(o.v).toLocaleString()) + suf;
                },
              });
            });
          },
        });

        // Endlessly cycle highlight down the log lines, like a live tail.
        gsap.fromTo(
          el.querySelectorAll('[data-log]'),
          { opacity: 0.2 },
          { opacity: 1, duration: DUR.base, ease: 'none', stagger: { each: 0.5, repeat: -1, yoyo: true, repeatDelay: 1.6 } },
        );
      });

      // Reduced motion: show final counts immediately, no reveal/loop.
      mm.add('(prefers-reduced-motion: reduce)', () => {
        setFinal();
      });
    },
    { scope: root, dependencies: [] },
  );

  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--s-16) var(--s-4)' }}>
      <div ref={root}>
        <div data-r style={{ textAlign: 'center', maxWidth: 600, margin: '0 auto var(--s-8)' }}>
          <span className="mono" style={{ fontSize: 'var(--fs-sm)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            {t('live.eyebrow')}
          </span>
          <h2 style={{ fontSize: 'var(--fs-h2)', fontWeight: 780, letterSpacing: '-0.02em', margin: 'var(--s-3) 0 0' }}>
            {t('live.title')}
          </h2>
          <p style={{ fontSize: 'var(--fs-base)', lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-3)' }}>{t('live.lead')}</p>
        </div>

        {/* console window: icon rail · stat tiles · live log */}
        <div data-r className="glass" style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', display: 'flex', minHeight: 300 }}>
          <div
            style={{
              width: 54,
              flexShrink: 0,
              borderRight: '1px solid var(--panel-bd)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--s-3)',
              padding: 'var(--s-4) 0',
            }}
          >
            {[SquaresFourIcon, WalletIcon, KeyIcon].map((Ic, i) => (
              <span
                key={i}
                aria-hidden="true"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: i === 0 ? 'var(--ink)' : 'var(--muted)',
                  background: i === 0 ? 'var(--grad-accent)' : 'transparent',
                }}
              >
                <Ic size={18} weight={i === 0 ? 'fill' : 'regular'} />
              </span>
            ))}
          </div>

          <div style={{ flex: 1, padding: 'var(--s-5)', minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--s-3)' }}>
              {STATS.map((s) => (
                <div key={s.key} className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
                  <div style={{ fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {t(`live.stats.${s.key}`)}
                  </div>
                  <div data-num={s.to} data-suffix={s.suffix} className="tabular" style={{ fontSize: 'clamp(20px, 3vw, 26px)', fontWeight: 700, marginTop: 6 }}>
                    0
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--faint)', margin: 'var(--s-4) 0 var(--s-2)' }}>
              {t('live.logTitle')}
            </div>
            <div
              className="mono"
              style={{
                background: 'rgba(0, 0, 0, 0.28)',
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-4)',
                fontSize: 'var(--fs-sm)',
                lineHeight: 2,
                color: 'var(--log-ok)',
                overflowX: 'auto',
              }}
            >
              {LOG.map((l) => (
                <div data-log key={l} style={{ whiteSpace: 'nowrap' }}>
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
